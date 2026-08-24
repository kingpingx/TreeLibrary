import { TreeBackend } from './tree-backend';
import { TreeDataModel } from './tree-data';

/**
 * Builds a tree to a shape you describe, rather than to the shape the sample payload happens
 * to have, so the component can be pushed at whatever geometry you want to test: very wide and
 * shallow, very deep and narrow, or one enormous level.
 *
 * A plan is one node count per level. `[3, 5, 10]` means three roots, five children under each
 * root, ten under each of those — 3 + 15 + 150 = 168 nodes. Nodes carry the same
 * {@link TreeDataModel} shape as the sample data, so the row component, both search modes and
 * the lazy-loading path all work against a generated tree unchanged.
 */

/** Most levels a plan may describe. Past this the row indent alone runs off the viewport. */
export const MAX_LEVELS = 10;

/** Most nodes one level may put under a single parent. */
export const MAX_LEVEL_WIDTH = 5000;

/**
 * Ceiling on a whole plan. Generation is synchronous and allocates an object per node, so this
 * is what stops a typo in the last level from locking up the tab.
 */
export const MAX_GENERATED_NODES = 500_000;

/** The plan the builder panel starts on: small enough to read, deep enough to show nesting. */
export const DEFAULT_LEVELS = [3, 5, 10];

/** Guard for the running total inside {@link projectedNodeCount}. */
const MAX_SAFE_TOTAL = Number.MAX_SAFE_INTEGER;

/**
 * How many nodes a plan produces: `c1 + c1*c2 + c1*c2*c3 + …`
 *
 * Returns `Infinity` rather than overflowing when the running product leaves the safe integer
 * range, so a wildly oversized plan is still comparable against {@link MAX_GENERATED_NODES}.
 */
export function projectedNodeCount(levels: readonly number[]): number {
    let perParent = 1,
        total = 0;

    for (const count of levels) {
        const width = Math.max(0, Math.floor(count));
        perParent *= width;

        if (!Number.isFinite(perParent) || perParent > Number.MAX_SAFE_INTEGER) {
            return Infinity;
        }

        total += perParent;
        if (total > MAX_SAFE_TOTAL) {
            return Infinity;
        }
    }

    return total;
}

export interface BuildOptions {
    /**
     * Keep every Nth branch on the "server", so it arrives with `children: []` and only fetches
     * when opened. 0 turns lazy loading off and generates a fully client-side tree.
     */
    lazyEvery?: number;
}

/** Icons come from the demo's own asset set, picked by the node's role rather than its domain. */
const ICON_ROOT_BRANCH = 'assets/server-cpu-connected.svg';
const ICON_BRANCH = 'assets/Outline/pipeline.svg';
const ICON_LEAF = 'assets/Outline/camera-bullet.svg';

/**
 * Generate a tree matching `levels` and hand back a {@link TreeBackend} holding it.
 *
 * Throws when the plan exceeds {@link MAX_GENERATED_NODES}; the caller is expected to have
 * checked {@link projectedNodeCount} first and to keep the generate control disabled until the
 * plan fits.
 */
export function buildCustomTree(levels: readonly number[], options: BuildOptions = {}): TreeBackend {
    const plan = levels.map(count => Math.max(0, Math.min(Math.floor(count), MAX_LEVEL_WIDTH))).slice(0, MAX_LEVELS);
    const projected = projectedNodeCount(plan);

    if (projected > MAX_GENERATED_NODES) {
        throw new Error(`Plan produces ${projected} nodes, over the ${MAX_GENERATED_NODES} limit`);
    }

    const lazyEvery = Math.max(0, Math.floor(options.lazyEvery ?? 0));
    const hidden = new Map<string, TreeDataModel[]>();
    const lazyNodes: TreeDataModel[] = [];

    let seq = 0;
    /** Counts branches in creation order, so "every Nth branch" is well defined. */
    let branchSeq = 0;

    /**
     * @param path 1-based position of each ancestor, so a node's name reads as its own address
     * @param insideLazy true once an ancestor is lazy — nesting a lazy node inside hidden data
     *        would leave it unreachable, since the backend indexes hidden nodes to one owner
     */
    const makeNode = (path: number[], insideLazy: boolean): TreeDataModel => {
        const depth = path.length - 1,
            label = path.join('.'),
            id = `gen-${++seq}`,
            childCount = plan[depth + 1] ?? 0,
            isParent = childCount > 0,
            ip = `10.${depth % 256}.${Math.floor(seq / 254) % 256}.${seq % 254}`;

        // Decided before the children are built, so a lazy branch can pass the flag down.
        const lazy = isParent && !insideLazy && lazyEvery > 0 && ++branchSeq % lazyEvery === 0;

        const node: TreeDataModel = {
            id,
            resourceId: `gen-res-${seq}`,
            name: `node ${label}`,
            children: null,
            data: {
                id,
                name: `node ${label}`,
                typeOfNode: `Level ${depth + 1}`,
                isDroppable: true,
                ip,
                normalizedId: seq,
                otherData: { path: label, depth: depth + 1, generated: true }
            },
            NodeUIState: { checked: false, loading: false },
            isParent,
            nocheck: false,
            icon: !isParent ? ICON_LEAF : depth === 0 ? ICON_ROOT_BRANCH : ICON_BRANCH,
            title:
                `Name: node ${label}\nId: ${id}\nLevel: ${depth + 1} of ${plan.length}\n` +
                `IP: ${ip}\nChildren: ${childCount}${lazy ? ' (loaded on demand)' : ''}\n`
        };

        if (isParent) {
            const children: TreeDataModel[] = [];
            for (let i = 0; i < childCount; i++) {
                children.push(makeNode([...path, i + 1], insideLazy || lazy));
            }

            if (lazy) {
                // The client sees an empty array and a true isParent, which is exactly the
                // "expandable but not loaded" state the tree's canExpand hook is for.
                node.children = [];
                hidden.set(node.id, children);
                lazyNodes.push(node);
            } else {
                node.children = children;
            }
        }

        return node;
    };

    const roots: TreeDataModel[] = [];
    const rootCount = plan[0] ?? 0;
    for (let i = 0; i < rootCount; i++) {
        roots.push(makeNode([i + 1], false));
    }

    return new TreeBackend(roots, hidden, lazyNodes);
}

/** Distinguishes hand-added nodes from one another. @see createManualNode */
let manualSeq = 0;

/**
 * A single node to insert by hand, in the same shape the generator produces.
 *
 * `isParent` starts false: a node added with no children is a leaf until something is put
 * under it, and claiming otherwise would draw an expander over nothing.
 */
export function createManualNode(name: string, depth: number): TreeDataModel {
    // A counter rather than a random value: ids have to be distinct, and two nodes added in the
    // same millisecond are exactly the case a timestamp gets wrong.
    const id = `manual-${++manualSeq}`;

    return {
        id,
        resourceId: id,
        name,
        children: null,
        data: {
            id,
            name,
            typeOfNode: 'Added by hand',
            isDroppable: true,
            ip: '0.0.0.0',
            otherData: { manual: true, depth: depth + 1 }
        },
        NodeUIState: { checked: false, loading: false },
        isParent: false,
        nocheck: false,
        icon: ICON_LEAF,
        title: `Name: ${name}\nId: ${id}\nAdded by hand at level ${depth + 1}\n`
    };
}
