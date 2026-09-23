import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Node, I2vTree, I2vTreeComponent } from 'i2v-tree';

import { TreeDataModel, createTreeData, loadedDescendants } from './tree-data';
import { TreeBackend, matches } from './tree-backend';
import {
    DEFAULT_LEVELS,
    MAX_GENERATED_NODES,
    MAX_LEVELS,
    MAX_LEVEL_WIDTH,
    buildCustomTree,
    createManualNode,
    projectedNodeCount
} from './tree-builder';
import { TreeNodeComponent } from './tree-node.component';
import { NodeToggleComponent } from './node-toggle.component';

/** Search walks every loaded node, so it is debounced rather than run per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

export type SearchMode = 'client' | 'server';

/**
 * Binds an analytic-server tree straight from the API payload, and offers both search
 * strategies so the trade-off between them is visible rather than theoretical.
 */
@Component({
    selector: 'app-server-tree-demo',
    standalone: true,
    imports: [FormsModule, I2vTreeComponent, TreeNodeComponent, NodeToggleComponent],
    templateUrl: './server-tree-demo.component.html',
    styleUrl: './server-tree-demo.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class ServerTreeDemoComponent {
    public readonly itemHeight = 28;

    /**
     * Swapped wholesale when a tree is generated, so it is a field rather than a constant. The
     * `I2vTree` above it is not swapped -- `model.load()` re-reads the roots in place, which keeps
     * the component's subscriptions and the `[model]` binding intact.
     */
    private backend: TreeBackend = createTreeData();

    /**
     * Bumped whenever the data set is replaced. The three counters below read it so they
     * recompute against the new backend; nothing else depends on its value.
     */
    private readonly dataset = signal(0);

    public readonly totalNodes = computed(() => (this.dataset(), this.backend.totalNodes));
    public readonly hiddenNodes = computed(() => (this.dataset(), this.backend.hiddenNodes));
    public readonly lazyServerCount = computed(() => (this.dataset(), this.backend.lazyServers.length));

    /** What the tree is currently showing, for the line under the builder panel. */
    public readonly datasetLabel = signal('Sample payload, scaled to 100,000 nodes');

    public readonly selected = signal<TreeDataModel | undefined>(undefined);
    /** Feedback from the row action buttons. */
    public readonly lastAction = signal<string | undefined>(undefined);
    private readonly checkedIds = signal(new Set<string>());
    /** State owned by this component, driven by a projected toggle rather than by the row. */
    private readonly enabledIds = signal(new Set<string>());

    public readonly searchMode = signal<SearchMode>('client');
    public readonly searchText = signal('');
    public readonly searching = signal(false);
    public readonly matchCount = signal(0);
    /** What the last search cost, so the two modes can be compared honestly. */
    public readonly lastSearch = signal<{ ms: number; requests: number; loaded: number } | undefined>(undefined);
    private searchTimer: ReturnType<typeof setTimeout> | undefined;
    private searchToken = 0;

    private readonly revision = signal(0);
    public readonly visibleRows = computed(() => {
        this.revision();
        return this.model.items.length;
    });
    public readonly checkedCount = computed(() => this.checkedIds().size);

    public readonly model = new I2vTree<TreeDataModel>({
        // `isParent` is the authority, NOT children.length. Lazy servers arrive with
        // children: [] but are still expandable - that is what drives the lazy fetch.
        canExpand: item => item.isParent,
        // null and [] both mean "nothing to walk yet". undefined is what the tree expects.
        childAccessor: item => item.children ?? undefined,
        lazyLoad: true
    });

    // --- Tree builder ---------------------------------------------------------------------
    //
    // A plan is one node count per level: [3, 5, 10] is three roots, five children under each,
    // ten under each of those. The panel edits the plan, previews what it costs, and only then
    // generates -- so an accidental [500, 500, 500] is reported rather than run.

    public readonly maxLevels = MAX_LEVELS;
    public readonly maxLevelWidth = MAX_LEVEL_WIDTH;
    public readonly maxGeneratedNodes = MAX_GENERATED_NODES;

    public readonly levels = signal<number[]>([...DEFAULT_LEVELS]);
    /** 0 turns lazy loading off; N keeps every Nth branch on the "server" until it is opened. */
    public readonly lazyEvery = signal(0);
    public readonly generating = signal(false);

    public readonly plannedNodes = computed(() => projectedNodeCount(this.levels()));
    public readonly planTooBig = computed(() => this.plannedNodes() > MAX_GENERATED_NODES);
    /** Per-level running totals, so the panel can show where the growth actually happens. */
    public readonly levelTotals = computed(() => {
        const totals: number[] = [];
        let perParent = 1;
        for (const count of this.levels()) {
            perParent = Math.min(perParent * Math.max(0, Math.floor(count)), Number.MAX_SAFE_INTEGER);
            totals.push(perParent);
        }
        return totals;
    });

    /** Name applied to the next hand-added node. Blank falls back to a generated one. */
    public readonly newNodeName = signal('');
    private manualSeq = 0;

    constructor() {
        this.model.load(this.backend.nodes);
        this.model.onDataInvalidated.pipe(takeUntilDestroyed()).subscribe(() => this.revision.update(n => n + 1));
    }

    public setLevelCount(index: number, value: number | string) {
        const count = Math.max(0, Math.min(Math.floor(Number(value) || 0), MAX_LEVEL_WIDTH));
        this.levels.update(prev => prev.map((existing, at) => (at === index ? count : existing)));
    }

    public addLevel() {
        this.levels.update(prev => (prev.length >= MAX_LEVELS ? prev : [...prev, 2]));
    }

    public removeLevel() {
        this.levels.update(prev => (prev.length <= 1 ? prev : prev.slice(0, -1)));
    }

    /**
     * Replace the tree with one built to the current plan.
     *
     * Generation is synchronous and can allocate hundreds of thousands of objects, so the busy
     * flag is set and the work deferred a frame -- otherwise the button never visibly changes
     * state, because the paint and the freeze happen in the same task.
     */
    public generate() {
        if (this.planTooBig() || this.generating()) {
            return;
        }

        this.generating.set(true);
        setTimeout(() => {
            const levels = this.levels();
            try {
                this.replaceData(
                    buildCustomTree(levels, { lazyEvery: this.lazyEvery() }),
                    `Generated: ${levels.join(' × ')} over ${levels.length} level${levels.length === 1 ? '' : 's'}`
                );
                this.lastAction.set(`Built ${this.totalNodes().toLocaleString()} nodes from ${levels.join(' × ')}`);
            } finally {
                this.generating.set(false);
            }
        });
    }

    /** Back to the payload the demo ships with. */
    public restoreSample() {
        this.replaceData(createTreeData(), 'Sample payload, scaled to 100,000 nodes');
        this.lastAction.set('Restored the sample payload');
    }

    /**
     * Point everything at a new backend. Search, selection and check state all describe nodes
     * that no longer exist, so all of it is cleared rather than carried across.
     */
    private replaceData(backend: TreeBackend, label: string) {
        clearTimeout(this.searchTimer);
        this.searchToken++;

        this.backend = backend;
        this.model.setFilter(undefined);
        this.model.load(backend.nodes);
        this.model.collapseAll();

        this.selected.set(undefined);
        this.checkedIds.set(new Set());
        this.enabledIds.set(new Set());
        this.searchText.set('');
        this.searching.set(false);
        this.matchCount.set(0);
        this.lastSearch.set(undefined);
        this.datasetLabel.set(label);
        this.dataset.update(n => n + 1);
    }

    // --- Adding nodes by hand -------------------------------------------------------------

    /** Append a node at the top level. */
    public addRootNode() {
        const node = createManualNode(this.nextName(), 0);
        this.backend.nodes.push(node);
        this.backend.addNode(node);
        this.dataset.update(n => n + 1);
        this.model.reloadTree();
        this.select(node);
        this.lastAction.set(`Added ${node.name} at the root`);
    }

    /**
     * Append a node under `parent`.
     *
     * A parent whose children are still on the server is fetched first: writing into its empty
     * array would clear the "not loaded yet" state and strand the real children.
     */
    public async addChildNode(parent: Node<TreeDataModel>) {
        const item = parent.item;

        if (this.needsLoad(item)) {
            await this.loadChildren(item);
        }

        const node = createManualNode(this.nextName(), parent.depth + 1);
        const children = item.children ?? (item.children = []);
        children.push(node);
        item.isParent = true;
        this.backend.addNode(node);
        this.dataset.update(n => n + 1);

        this.model.setExpanded(item, true);
        this.model.invalidateItem(item);
        this.select(node);
        this.lastAction.set(`Added ${node.name} under ${item.name}`);
    }

    private nextName() {
        const typed = this.newNodeName().trim();
        return typed || `new node ${++this.manualSeq}`;
    }

    public get isFiltered() {
        return this.model.isFiltered();
    }

    public setMode(mode: SearchMode) {
        if (this.searchMode() === mode) {
            return;
        }
        this.searchMode.set(mode);
        if (this.searchText()) {
            this.onSearch(this.searchText());
        }
    }

    public onSearch(value: string) {
        this.searchText.set(value);
        clearTimeout(this.searchTimer);

        const term = value.trim().toLowerCase();
        const token = ++this.searchToken;

        if (!term) {
            this.searching.set(false);
            this.model.setFilter(undefined);
            this.matchCount.set(0);
            this.lastSearch.set(undefined);
            return;
        }

        this.searching.set(true);
        this.searchTimer = setTimeout(() => {
            if (this.searchMode() === 'server') {
                void this.runServerSearch(term, token);
            } else {
                this.runClientSearch(term, token);
            }
        }, SEARCH_DEBOUNCE_MS);
    }

    public clearSearch() {
        this.onSearch('');
    }

    /**
     * Client-side: pull down every lazy server first, then filter locally. Complete coverage,
     * but it costs one request per unloaded server before the first result can be shown.
     */
    private async runClientSearch(term: string, token: number) {
        const started = performance.now();
        const outstanding = this.backend.lazyServers.filter(server => this.needsLoad(server));

        if (outstanding.length) {
            await Promise.all(outstanding.map(server => this.loadChildren(server)));
            if (token !== this.searchToken) {
                return;
            }
            this.model.reloadTree();
        }

        const predicate = (item: TreeDataModel) => matches(item, term);
        this.model.setFilter(predicate);
        this.matchCount.set(this.model.items.filter(node => predicate(node.item)).length);
        this.lastSearch.set({
            ms: Math.round(performance.now() - started),
            requests: outstanding.length,
            loaded: outstanding.length
        });
        this.searching.set(false);
    }

    /**
     * Server-side: ask the API which nodes match, then load only the servers needed to show
     * them. One search request plus a fetch per server that actually contains a hit.
     */
    private async runServerSearch(term: string, token: number) {
        const started = performance.now();
        const result = await this.backend.search(term);
        if (token !== this.searchToken) {
            return;
        }

        const toLoad = result.serversToLoad.filter(server => this.needsLoad(server));
        if (toLoad.length) {
            await Promise.all(toLoad.map(server => this.loadChildren(server)));
            if (token !== this.searchToken) {
                return;
            }
            this.model.reloadTree();
        }

        this.model.setFilter(item => result.matchIds.has(item.id));
        this.matchCount.set(result.total);
        this.lastSearch.set({
            ms: Math.round(performance.now() - started),
            requests: 1 + toLoad.length,
            loaded: toLoad.length
        });
        this.searching.set(false);
    }

    public isChecked(item: TreeDataModel) {
        return this.checkedIds().has(item.id);
    }

    /**
     * A node that still needs loading is always fetched and left expanded, whatever its
     * current expand state. Without that, a lazy server left "expanded but empty" by
     * expandAll would need two clicks: one to collapse, another to load.
     */
    public async toggle(item: TreeDataModel, event: MouseEvent) {
        event.stopPropagation();
        if (!item.isParent || item.NodeUIState.loading) {
            return;
        }

        if (this.needsLoad(item)) {
            await this.loadChildren(item);
            this.model.setExpanded(item, true);
            this.model.invalidateItem(item);
            return;
        }

        this.model.toggle(item);
    }

    // --- Handlers for the actions this component projects into each row -------------------

    public showInfo(node: Node<TreeDataModel>) {
        const item = node.item;
        this.select(item);
        this.lastAction.set(`${item.name} — ${item.data.typeOfNode}, ${item.data.ip}, id ${item.resourceId}`);
    }

    public copyId(item: TreeDataModel) {
        navigator.clipboard?.writeText(item.resourceId).catch(() => undefined);
        this.lastAction.set(`Copied resource id of ${item.name}`);
    }

    public removeNode(node: Node<TreeDataModel>) {
        // Mutate the data, then tell the tree that this parent's children changed.
        const item = node.item;
        const parent = node.parent;
        const siblings = this.childListOf(parent);
        const index = siblings.indexOf(item);
        if (index < 0) {
            return;
        }
        siblings.splice(index, 1);
        // Drop it from the authoritative set too, or server-side search keeps returning a node
        // the tree can no longer show.
        this.backend.removeNode(item);
        this.dataset.update(n => n + 1);

        if (this.selected() === item) {
            this.selected.set(undefined);
        }
        // A top-level node's parent is the tree's synthetic root, whose item is not one of
        // ours, so the whole tree has to be re-read in that case.
        if (parent && !parent.isRoot) {
            this.model.invalidateItem(parent.item);
        } else {
            this.model.reloadTree();
        }
        this.lastAction.set(`Removed ${item.name}`);
    }

    public isEnabled(item: TreeDataModel) {
        return this.enabledIds().has(item.id);
    }

    public setEnabled(item: TreeDataModel, on: boolean) {
        this.enabledIds.update(prev => {
            const next = new Set(prev);
            if (on) {
                next.add(item.id);
            } else {
                next.delete(item.id);
            }
            return next;
        });
        this.lastAction.set(`${item.name} ${on ? 'enabled' : 'disabled'}`);
    }

    public select(item: TreeDataModel) {
        this.model.selectAndHighlight(item);
        this.selected.set(item);
    }

    /** Checking a node cascades to every descendant that is currently loaded. */
    public toggleCheck(item: TreeDataModel, event: Event) {
        event.stopPropagation();
        const turningOn = !this.isChecked(item);
        const affected = [item, ...loadedDescendants(item)];

        this.checkedIds.update(prev => {
            const next = new Set(prev);
            for (const node of affected) {
                if (turningOn) {
                    next.add(node.id);
                } else {
                    next.delete(node.id);
                }
                node.NodeUIState.checked = turningOn;
            }
            return next;
        });
    }

    /**
     * Lazy servers are deliberately left collapsed. Marking them expanded would render a
     * down arrow over nothing, since their children are not client-side yet.
     */
    public expandAll() {
        this.model.expandAll();
        for (const server of this.backend.lazyServers) {
            if (this.needsLoad(server)) {
                this.model.setExpanded(server, false);
            }
        }
        this.model.invalidateData();
    }

    public collapseAll() {
        this.model.collapseAll();
    }

    public selectedPath() {
        const item = this.selected();
        if (!item) {
            return '(nothing selected)';
        }
        const node = this.model.getTreeNode(item);
        if (!node) {
            return item.name;
        }

        const parts = [node.item.name];
        for (const ancestor of node.ancestors()) {
            if (!ancestor.isRoot) {
                parts.unshift(ancestor.item.name);
            }
        }
        return '/' + parts.join('/');
    }

    public trackLabel(node: Node<TreeDataModel>) {
        const { typeOfNode, ip } = node.item.data;

        if (typeOfNode === 'VideoSource') {
            return ip;
        }
        if (typeOfNode === 'Pipeline') {
            const sources = node.item.children?.length ?? 0;
            return `${sources} source${sources === 1 ? '' : 's'} · Pipeline`;
        }
        return `${ip} · ${typeOfNode}`;
    }

    /** The array a node lives in: its parent's children, or the root data set. */
    private childListOf(node: Node<TreeDataModel> | undefined): TreeDataModel[] {
        return !node || node.isRoot ? this.backend.nodes : (node.item.children ?? []);
    }

    private needsLoad(item: TreeDataModel) {
        return item.isParent && (item.children === null || item.children.length === 0);
    }

    /**
     * The busy state is written into the node's NodeUIState, not held in a set here, because
     * it is the node that is loading - which is how the row can show a busy expander without
     * being told to. This is the only writer, so no path can forget to clear the flag.
     */
    private async loadChildren(server: TreeDataModel) {
        server.NodeUIState.loading = true;
        try {
            server.children = await this.backend.fetchChildren(server);
        } finally {
            server.NodeUIState.loading = false;
        }
    }
}
