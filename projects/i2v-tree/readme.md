# i2v Tree 🥦

This is a virtual tree for Angular (requires Angular 18). It has excellent performance for 10s of thousands of items, supports search, expand/collapse all, templating, drag and drop, lazy load, keyboard navigation.

## Features
- **Configurability** - *Easy out-of-the-box settings can be easily overridden to support exotic scenarios*
- **No Dependencies** - *This is built on Angular alone, no other libraries needed*
- **Keyboard Navigation** - *Supports standard arrow-key tree behavior*
- **Search** - *Immediate or throttled, text or faceted search of a huge number of nodes*
- **Expand/Collapse All** - *Expand all instantly even on 10s of thousands of nodes*
- **Templatible** - *Have complete control over the appearance and behavior*
- **Schemaless** - *Bind to data with a few known properties OR bind to any data whatsoever via simple configuration*
- **Lazy load** - *Easily minimize data requests by loading child nodes on demand, by depth and ancestry*
- **Drag and Drop** - *Reparent nodes by dragging*
- **Navigate To** - *Expand and scroll immediately to any item in the tree, any depth*

## More Info

- [Live demo](https://claude.ai/code/artifact/2a360068-1175-40f4-b48c-b569f1f7c2cd) - 100,000 nodes, lazy loading, and a tree builder for your own shapes
- [Usage guide](../../docs/USAGE.md) - updating nodes, lazy loading, filtering, templating, drag and drop

## How does it work?

This tree component supports a huge number of nodes with minimal performance impact to the app hosting it. It does this by virtualizing the view of nodes, so that only the nodes visible in a scrollable container are rendered. However, virtualizing a hierarchical data structure is complicated. If the DOM structure were rendered hierarchically like the data, then it could not be virtualized. So, the data must be flattened before it is virtualized. Now, if the data is just flattened, then we the information about the depth and relationships of the hierarchical data is lost. So, before flattening the data, the metadata describing the relationships of the data must be stored.

To summarize, this tree is built around this recipe (which works for any hierarchical data view):
1. Store hierarchy metadata
1. Flatten the data
1. Virtualize, render only visible items

## Install

`npm i i2v-tree` obviously

## Quick Setup

1. Import the component

The component is standalone, so import it directly where you use it:

```typescript
import { I2vTreeComponent } from 'i2v-tree';

@Component({
  standalone: true,
  imports: [I2vTreeComponent],
  ...
})
export class MyComponent { }
```

If you are still on NgModules, `I2vTreeModule` exports the component and works unchanged:

```typescript
import { I2vTreeModule } from 'i2v-tree';

@NgModule({
  imports: [..., I2vTreeModule],
  ...
})
export class AppModule { }
```


2. Use the `i2v-tree` component
```typescript
import { Component } from '@angular/core';
import { I2vTreeComponent } from 'i2v-tree';

@Component({
    standalone: true,
    imports: [I2vTreeComponent],
    template: `
        <div class="container">
            <i2v-tree [(selection)]="selectedItem" [data]="treeData"></i2v-tree>
        </div>`,
    styles: [`
        .container { height: 400px; }
    `]
})
export class MyComponent {
    public selectedItem?: IMyDataType;
    public treeData: IMyDataType[] = [];
}

interface IMyDataType {
    name: string;
    children: IMyDataType[];
    type: 'Folder' | 'File';
}
```

For the most minimal setup expects, provide data with known properties, and put the tree inside a container of a non-zero height. However, the tree is very configurable. It has a robust public API and allows detailed configuration.

3. Take over the row when you need to

Project an `<ng-template>` and the tree renders that instead of its built-in row. You get the
`Node` for the row, plus the usual `index`/`first`/`last`/`count`/`even`/`odd` context:

```html
<i2v-tree [itemHeight]="24" [model]="model">
    <ng-template let-node let-index="index">
        <div class="my-row">{{ index }}: {{ node.item.name }}</div>
    </ng-template>
</i2v-tree>
```

> Binding `[(selection)]` emits `selectionChange` while the parent's inputs are still being set,
> which Angular's dev mode may report as `ExpressionChangedAfterItHasBeenChecked`. It settles on
> the next pass; bind `[selection]` and `(selectionChange)` separately to avoid the warning.

## Migrating from `of-tree`

The package was renamed from `of-tree` to `i2v-tree`, and the `of` prefix became `i2v`
throughout. At the same time `of-basic-tree` was folded into the one remaining component, which
now renders the built-in row when no template is projected. To migrate:

| Before | After |
| --- | --- |
| `npm i of-tree` | `npm i i2v-tree` |
| `<of-basic-tree …>` / `<of-virtual-tree …>` | `<i2v-tree …>` |
| `OfBasicTreeComponent` / `OfVirtualTreeComponent` | `I2vTreeComponent` |
| `OfVirtualTree` / `OfVirtualTreeModule` | `I2vTree` / `I2vTreeModule` |
| `VtBasicTreeConfig<T>` / `OfTreeConfig<T>` | `I2vTreeConfig<T>` |
| `VtItemState<T>` | `I2vItemState<T>` |
| `[ofSetAttrs]` | `[i2vSetAttrs]` |
| `basicTree.tree.scrollTo(…)` | `tree.scrollTo(…)` — the inner `tree` handle is gone |

If you style the tree, every CSS class moved to the `i2v-` prefix: `of-node` → `i2v-node`, and
likewise for `of-label`, `of-selected`, `of-highlight`, `of-icon`, `of-expander`, `of-dragoverlay`
and the icon classes. The two internal layout classes were renamed as well — `vt-container` →
`i2v-container` and `vt-bottom-space` → `i2v-bottom-space`.

Cross-window drag now uses the `application/json.i2v-tree-item` dataTransfer key, so a page
running the old build cannot exchange nodes with one running this build.

Every input, output and method keeps its name and signature. `canDrag` and `handleDragstart` are
public, so a projected row can opt into the built-in drag and drop by wiring
`[draggable]="tree.canDrag(node.item)" (dragstart)="tree.handleDragstart($event, node)"`.

## Browser Support

| [<img src="https://raw.githubusercontent.com/alrra/browser-logos/master/src/chrome/chrome_48x48.png" alt="Chrome" width="24px" height="24px" />](http://godban.github.io/browsers-support-badges/)<br>Chrome | [<img src="https://raw.githubusercontent.com/alrra/browser-logos/master/src/edge/edge_48x48.png" alt="IE / Edge" width="24px" height="24px" />](http://godban.github.io/browsers-support-badges/)<br>IE / Edge | [<img src="https://raw.githubusercontent.com/alrra/browser-logos/master/src/firefox/firefox_48x48.png" alt="Firefox" width="24px" height="24px" />](http://godban.github.io/browsers-support-badges/)<br>Firefox |
| --------- | --------- | --------- |
| last version | Edge (Partial) | last version |

This virtual tree is intended for business applications where the on-call support can fix most problems by asking "did you try it in chrome?" Developing for one browser is very cost effective. One nice way to contribute is to fix support issues for others browsers or test them and report issues. 

## Other Options

Here are some other virtual tree implementations for angular.
- `angular-tree-component` [Demo](https://angular2-tree.readme.io/docs/large-trees) [Source](https://github.com/500tech/angular-tree-component)
- ...I'm sure there are others out there, just can't find them atm

## Contribute

If you find a bug, the best thing is to fix it, and submit a pull request. The second best thing is to open an issue and provide a lot of details and rage emojis and venting. The worst best thing is to not do anything. Any contribution is appreciated :)

Run `npm start`

Open [localhost:4200](http://localhost:4200) in chrome
