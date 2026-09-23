import { ComponentFixture, TestBed, waitForAsync } from '@angular/core/testing';

import { AppComponent } from './app.component';
import { ServerTreeDemoComponent } from './demos/server-tree-demo.component';
import { isPartiallyChecked } from './demos/tree-data';

/** Waits for a debounced + awaited search to settle. */
async function settle(fixture: ComponentFixture<AppComponent>, demo: ServerTreeDemoComponent, timeoutMs = 15000) {
    const started = Date.now();
    while (demo.searching() && Date.now() - started < timeoutMs) {
        await new Promise(r => setTimeout(r, 50));
    }
    fixture.detectChanges();
}

describe('i2v-tree demo', () => {
    let fixture: ComponentFixture<AppComponent>;
    let demo: ServerTreeDemoComponent;

    const rows = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.i2v-container .row'));
    const rowText = () => rows().map(r => (r.textContent || '').replace(/\s+/g, ' ').trim());

    beforeEach(waitForAsync(() => {
        TestBed.configureTestingModule({ imports: [AppComponent] }).compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(AppComponent);
        fixture.detectChanges();
        demo = fixture.debugElement.query(el => el.name === 'app-server-tree-demo').componentInstance;
    });

    it('renders the tree without rendering the whole data set', () => {
        expect(demo.totalNodes()).toBeGreaterThanOrEqual(100000);
        expect(rows().length).toBeGreaterThan(0);
        expect(rows().length).toBeLessThan(demo.model.items.length);
    });

    it('keeps the original sample rows verbatim at the top, with no checkbox', () => {
        const first = rowText().slice(0, 2);
        expect(first[0]).toContain('cpu');
        expect(first[1]).toContain('gpu');

        expect(rows()[0].querySelector('input[type=checkbox]')).toBeNull();
        expect(rows()[1].querySelector('input[type=checkbox]')).toBeNull();
    });

    it('renders a checkbox for generated nodes, which use nocheck: false', () => {
        const generated = rows().find(r => (r.textContent || '').includes('cpu-00001'));
        expect(generated!.querySelector('input[type=checkbox]')).not.toBeNull();
    });

    it('holds some nodes back on the server so the two search modes differ', () => {
        expect(demo.lazyServerCount()).toBeGreaterThan(0);
        expect(demo.hiddenNodes()).toBeGreaterThan(0);
    });

    it('expandAll leaves lazy servers collapsed rather than expanded-but-empty', () => {
        demo.expandAll();

        const stillLazy = demo.model.items.filter(n => n.item.isParent && n.item.children?.length === 0);
        expect(stillLazy.length).toBeGreaterThan(0);
        stillLazy.forEach(n => expect(demo.model.isExpanded(n.item)).toBe(false));

        demo.collapseAll();
    });

    it('loads a lazy server in a single click even when already marked expanded', async () => {
        const server = demo.model.items.find(n => n.item.isParent && n.item.children?.length === 0)!.item;

        // reproduce the post-expandAll state: flagged expanded but with no children
        demo.model.setExpanded(server, true);
        expect(demo.model.isExpanded(server)).toBe(true);
        expect(server.children!.length).toBe(0);

        await demo.toggle(server, new MouseEvent('click'));

        expect(server.children!.length).toBeGreaterThan(0);
        expect(demo.model.isExpanded(server)).toBe(true);
    });

    it('client-side search finds a node that was never loaded, by loading everything', async () => {
        const server = demo.model.items.find(n => n.item.isParent && n.item.children?.length === 0)!.item;

        demo.setMode('client');
        demo.onSearch(server.name);
        await settle(fixture, demo);

        expect(demo.matchCount()).toBeGreaterThan(0);
        expect(demo.lastSearch()!.requests).toBe(demo.lazyServerCount());

        demo.clearSearch();
    });

    it('server-side search finds the same node while loading only what it needs', async () => {
        const server = demo.model.items.find(n => n.item.isParent && n.item.children?.length === 0)!.item;

        demo.setMode('server');
        demo.onSearch(server.name);
        await settle(fixture, demo);

        expect(demo.matchCount()).toBeGreaterThan(0);
        // one search request plus at most one fetch, versus one fetch per lazy server
        expect(demo.lastSearch()!.requests).toBeLessThan(demo.lazyServerCount());

        demo.clearSearch();
    });

    it('restores the full tree when the search is cleared', async () => {
        const before = demo.model.items.length;

        demo.setMode('server');
        demo.onSearch('AnalyticServerGPU');
        await settle(fixture, demo);
        expect(demo.isFiltered).toBe(true);

        demo.clearSearch();
        fixture.detectChanges();

        expect(demo.isFiltered).toBe(false);
        expect(demo.matchCount()).toBe(0);
        expect(demo.model.items.length).toBe(before);
    });

    it('nests cameras under pipelines on GPU servers, giving a third level', () => {
        const gpu = demo.model.items.find(n => n.item.data.typeOfNode === 'AnalyticServerGPU' && n.item.children?.length)!.item;
        const pipeline = gpu.children![0];

        expect(pipeline.data.typeOfNode).toBe('Pipeline');
        expect(pipeline.isParent).toBe(true);
        expect(pipeline.children!.length).toBeGreaterThan(0);
        expect(pipeline.children![0].data.typeOfNode).toBe('VideoSource');
        expect(pipeline.children![0].children).toBeNull();
    });

    it('renders three indent levels once a GPU and a pipeline are expanded', () => {
        const gpu = demo.model.items.find(n => n.item.data.typeOfNode === 'AnalyticServerGPU' && n.item.children?.length)!.item;
        demo.model.setExpanded(gpu, true);
        demo.model.setExpanded(gpu.children![0], true);
        demo.model.invalidateData();
        fixture.detectChanges();

        const depths = demo.model.items.slice(0, 40).map(n => n.depth);
        expect(Math.max(...depths)).toBe(2);

        demo.collapseAll();
    });

    it('cascades a check from a pipeline down to its cameras', () => {
        const gpu = demo.model.items.find(n => n.item.data.typeOfNode === 'AnalyticServerGPU' && n.item.children?.length)!.item;
        const pipeline = gpu.children![0];

        demo.toggleCheck(pipeline, new MouseEvent('click'));

        expect(demo.isChecked(pipeline)).toBe(true);
        expect(pipeline.children!.every(c => demo.isChecked(c))).toBe(true);
        // the server above is only partly checked - derived from the subtree, which is why
        // the row can work it out for itself rather than being handed an [indeterminate]
        expect(isPartiallyChecked(gpu)).toBe(true);

        demo.toggleCheck(pipeline, new MouseEvent('click'));
    });

    it('renders each row as its own component, one per visible row only', () => {
        const host = fixture.nativeElement as HTMLElement;
        const nodeComponents = host.querySelectorAll('app-tree-node');

        expect(nodeComponents.length).toBeGreaterThan(0);
        expect(nodeComponents.length).toBe(rows().length);
        expect(nodeComponents.length).toBeLessThan(demo.model.items.length);
    });

    it('keeps the row component exactly itemHeight tall', () => {
        const row = (fixture.nativeElement as HTMLElement).querySelector('app-tree-node .row') as HTMLElement;
        const hostEl = (fixture.nativeElement as HTMLElement).querySelector('app-tree-node') as HTMLElement;

        // a row that renders taller than it claims makes the scroller drift
        expect(row.getBoundingClientRect().height).toBe(demo.itemHeight);
        expect(hostEl.getBoundingClientRect().height).toBe(demo.itemHeight);
    });

    it('derives the expander from the data model rather than a passed-in flag', () => {
        const host = fixture.nativeElement as HTMLElement;
        const nodeEls = Array.from(host.querySelectorAll('app-tree-node'));

        const parentRow = nodeEls.find(el => (el.textContent || '').includes('cpu-00001'))!;
        const parentItem = demo.model.items.find(n => n.item.name === 'cpu-00001')!.item;

        expect(parentItem.isParent).toBe(true);
        expect(parentRow.querySelector('.expander-empty')).toBeNull();
        expect(parentRow.querySelector('.expander')).not.toBeNull();

        // and a leaf gets the empty placeholder
        demo.model.setExpanded(parentItem, true);
        demo.model.invalidateData();
        fixture.detectChanges();

        const leafEl = Array.from(host.querySelectorAll('app-tree-node')).find(el =>
            (el.textContent || '').includes('cpu-00001-cam-')
        )!;
        expect(leafEl.querySelector('.expander-empty')).not.toBeNull();

        demo.collapseAll();
    });

    it('derives the selected row from the tree rather than a passed-in flag', () => {
        const first = demo.model.items[0].item;
        const second = demo.model.items[1].item;

        demo.select(first);
        fixture.detectChanges();
        expect(rows()[0].classList).toContain('selected');
        expect(rows()[1].classList).not.toContain('selected');

        // select() does not rebuild the item list, so the previously selected row can only
        // lose its highlight by re-reading the state from the tree on each check
        demo.select(second);
        fixture.detectChanges();
        expect(rows()[0].classList).not.toContain('selected');
        expect(rows()[1].classList).toContain('selected');
    });

    it('derives each checkbox from the node, so a cascade repaints the descendant rows', () => {
        const server = demo.model.items.find(n => n.item.name === 'cpu-00001')!.item;
        demo.model.setExpanded(server, true);
        demo.model.invalidateData();
        fixture.detectChanges();

        const index = demo.model.items.findIndex(n => n.item === server);
        const boxAt = (i: number) => rows()[i].querySelector('input[type=checkbox]') as HTMLInputElement;

        demo.toggleCheck(server, new MouseEvent('click'));
        fixture.detectChanges();
        expect(boxAt(index).checked).toBe(true);
        // the cascade never touches the child row's inputs - only its item's checked flag
        expect(boxAt(index + 1).checked).toBe(true);

        demo.toggleCheck(server, new MouseEvent('click'));
        fixture.detectChanges();
        expect(boxAt(index).checked).toBe(false);
        expect(boxAt(index + 1).checked).toBe(false);

        demo.collapseAll();
    });

    it('shows a busy expander while the node carries its own loading flag', async () => {
        const lazy = demo.model.items.find(n => n.item.isParent && n.item.children?.length === 0)!.item;
        const index = demo.model.items.findIndex(n => n.item === lazy);
        const busy = () => rows()[index].querySelector('.expander-busy');

        // clicked rather than called: the click is what marks the row for check, which is
        // how the app repaints a row whose state changed without any input changing
        rows()[index].querySelector('i')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        fixture.detectChanges();

        expect(lazy.NodeUIState.loading).toBe(true);
        expect(busy()).not.toBeNull();

        while (lazy.NodeUIState.loading) {
            await new Promise(r => setTimeout(r, 25));
        }
        fixture.detectChanges();

        expect(lazy.children!.length).toBeGreaterThan(0);
        expect(busy()).toBeNull();

        demo.collapseAll();
    });

    it('keeps the expander visible on a matched but unloaded node during a search', () => {
        const lazy = demo.model.items.find(n => n.item.isParent && n.item.children?.length === 0)!.item;

        // I2vTree.isExpandable() falls back to loaded-child count while filtered,
        // which would have hidden this expander; reading isParent does not.
        demo.model.setFilter(item => item.id === lazy.id);
        fixture.detectChanges();

        expect(demo.model.isExpandable(lazy)).toBe(false);
        const el = (fixture.nativeElement as HTMLElement).querySelector('app-tree-node')!;
        expect(el.querySelector('.expander-empty')).toBeNull();

        demo.model.setFilter(undefined);
    });

    it('projects the caller-supplied actions into each row', () => {
        const host = fixture.nativeElement as HTMLElement;
        const slot = host.querySelector('app-tree-node .actions')!;

        // the row owns the slot but not its contents
        expect(slot.querySelector('app-node-toggle')).not.toBeNull();
        // add child, details, copy id, remove
        expect(slot.querySelectorAll('button.row-action').length).toBe(4);
    });

    it('removes a node from the data via a projected action', () => {
        const server = demo.model.items.find(n => n.item.name === 'cpu-00001')!;
        demo.model.setExpanded(server.item, true);
        demo.model.invalidateData();
        fixture.detectChanges();

        const before = server.item.children!.length;
        const child = demo.model.items.find(n => n.item.name.startsWith('cpu-00001-cam-'))!;

        demo.removeNode(child);

        expect(server.item.children!.length).toBe(before - 1);
        expect(server.item.children).not.toContain(child.item);
    });

    it('drives component-based actions, not just buttons', () => {
        const item = demo.model.items[0].item;
        expect(demo.isEnabled(item)).toBe(false);

        demo.setEnabled(item, true);
        expect(demo.isEnabled(item)).toBe(true);

        demo.setEnabled(item, false);
        expect(demo.isEnabled(item)).toBe(false);
    });

    it('replaces the data set with a tree built to the given plan', async () => {
        demo.levels.set([2, 3, 4]);
        expect(demo.plannedNodes()).toBe(2 + 6 + 24);
        expect(demo.planTooBig()).toBe(false);

        demo.generate();
        // generate() defers the build off the click, so the busy state is visible.
        await new Promise(r => setTimeout(r, 0));
        fixture.detectChanges();

        expect(demo.generating()).toBe(false);
        expect(demo.totalNodes()).toBe(32);
        expect(demo.model.items.length).toBe(2);
        expect(demo.model.items.map(n => n.item.name)).toEqual(['node 1', 'node 2']);
        // Nothing carried over from the payload it replaced.
        expect(demo.selected()).toBeUndefined();
        expect(demo.checkedCount()).toBe(0);
        expect(demo.isFiltered).toBe(false);
    });

    it('refuses to build a plan past the node ceiling', () => {
        demo.levels.set([5000, 5000, 5000]);
        expect(demo.planTooBig()).toBe(true);

        const before = demo.totalNodes();
        demo.generate();
        expect(demo.totalNodes()).toBe(before);
    });

    it('adds a node at the root by hand', () => {
        const before = demo.model.items.length;
        demo.newNodeName.set('by hand');

        demo.addRootNode();
        fixture.detectChanges();

        expect(demo.model.items.length).toBe(before + 1);
        expect(demo.model.items[demo.model.items.length - 1].item.name).toBe('by hand');
        expect(demo.selectedPath()).toBe('/by hand');
    });

    it('adds a child under an existing node by hand', async () => {
        const server = demo.model.items.find(n => n.item.name === 'cpu-00001')!;
        const before = server.item.children!.length;
        demo.newNodeName.set('child by hand');

        await demo.addChildNode(server);
        fixture.detectChanges();

        expect(server.item.children!.length).toBe(before + 1);
        expect(server.item.children![before].name).toBe('child by hand');
        // The parent is opened, so the node the user just created is actually on screen.
        expect(demo.model.isExpanded(server.item)).toBe(true);
        expect(rowText().some(text => text.includes('child by hand'))).toBe(true);
    });

    it('cascades a check to loaded descendants', () => {
        const server = demo.model.items.find(n => n.item.name === 'cpu-00001')!.item;
        expect(server.children?.length).toBeGreaterThan(0);

        demo.toggleCheck(server, new MouseEvent('click'));

        expect(demo.isChecked(server)).toBe(true);
        expect(server.children!.every(child => demo.isChecked(child))).toBe(true);
        expect(demo.checkedCount()).toBe(1 + server.children!.length);
    });
});
