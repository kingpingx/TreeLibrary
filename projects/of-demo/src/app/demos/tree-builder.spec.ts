import { MAX_GENERATED_NODES, buildCustomTree, createManualNode, projectedNodeCount } from './tree-builder';
import { TreeDataModel } from './tree-data';

/** Every node in a set of roots, walking only what the client can see. */
function walk(nodes: TreeDataModel[]): TreeDataModel[] {
    const all: TreeDataModel[] = [];
    const visit = (list: TreeDataModel[] | null) => {
        for (const node of list ?? []) {
            all.push(node);
            visit(node.children);
        }
    };
    visit(nodes);
    return all;
}

describe('projectedNodeCount', () => {
    it('sums the running product of each level', () => {
        // 3 roots, 5 under each, 10 under each of those
        expect(projectedNodeCount([3, 5, 10])).toBe(3 + 15 + 150);
        expect(projectedNodeCount([2])).toBe(2);
        expect(projectedNodeCount([])).toBe(0);
    });

    it('reports Infinity rather than a wrong number for an absurd plan', () => {
        expect(projectedNodeCount([5000, 5000, 5000, 5000, 5000])).toBe(Infinity);
    });

    it('collapses to zero once a level is empty', () => {
        // Nothing at level 2 means nothing can hang below it either.
        expect(projectedNodeCount([4, 0, 100])).toBe(4);
    });
});

describe('buildCustomTree', () => {
    it('builds exactly the planned shape', () => {
        const backend = buildCustomTree([2, 3, 4]);
        const all = walk(backend.nodes);

        expect(backend.nodes.length).toBe(2);
        expect(all.length).toBe(projectedNodeCount([2, 3, 4]));
        expect(backend.totalNodes).toBe(all.length);
        expect(backend.nodes[0].children!.length).toBe(3);
        expect(backend.nodes[0].children![0].children!.length).toBe(4);
    });

    it('names each node after its own position', () => {
        const backend = buildCustomTree([2, 2]);

        expect(backend.nodes.map(n => n.name)).toEqual(['node 1', 'node 2']);
        expect(backend.nodes[1].children!.map(n => n.name)).toEqual(['node 2.1', 'node 2.2']);
    });

    it('marks the deepest level as leaves and everything above as expandable', () => {
        const backend = buildCustomTree([2, 2]);
        const [root] = backend.nodes;

        expect(root.isParent).toBe(true);
        expect(root.children!.every(child => child.isParent)).toBe(false);
        expect(root.children!.every(child => child.children === null)).toBe(true);
    });

    it('holds every Nth branch back for the lazy path', () => {
        const backend = buildCustomTree([4, 3], { lazyEvery: 2 });

        // Two of the four branches are lazy: client-side they are empty but still expandable.
        expect(backend.lazyServers.length).toBe(2);
        for (const lazy of backend.lazyServers) {
            expect(lazy.isParent).toBe(true);
            expect(lazy.children).toEqual([]);
        }

        // The hidden children still exist as far as the backend is concerned.
        expect(walk(backend.nodes).length).toBe(4 + 2 * 3);
        expect(backend.totalNodes).toBe(projectedNodeCount([4, 3]));
        expect(backend.hiddenNodes).toBe(2 * 3);
    });

    it('generates a fully client-side tree when lazy loading is off', () => {
        const backend = buildCustomTree([3, 3], { lazyEvery: 0 });

        expect(backend.lazyServers.length).toBe(0);
        expect(backend.hiddenNodes).toBe(0);
    });

    it('refuses a plan past the node ceiling instead of trying it', () => {
        expect(() => buildCustomTree([5000, 5000, 5000])).toThrowError(/over the/);
        expect(projectedNodeCount([5000, 5000, 5000])).toBeGreaterThan(MAX_GENERATED_NODES);
    });
});

describe('createManualNode', () => {
    it('starts as a leaf, so no expander is drawn over nothing', () => {
        const node = createManualNode('added by hand', 2);

        expect(node.name).toBe('added by hand');
        expect(node.isParent).toBe(false);
        expect(node.children).toBeNull();
        expect(node.nocheck).toBe(false);
    });

    it('gives every node a distinct id', () => {
        const ids = new Set(Array.from({ length: 50 }, (_, i) => createManualNode(`n${i}`, 0).id));
        expect(ids.size).toBe(50);
    });
});
