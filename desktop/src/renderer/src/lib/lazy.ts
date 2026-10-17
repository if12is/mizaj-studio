import { defineAsyncComponent, type AsyncComponentLoader, type Component } from 'vue'
import SkeletonBlock from '@renderer/components/ui/SkeletonBlock.vue'

/** Lazy panel/tab: a skeleton shows if the chunk takes longer than 80 ms; no flash otherwise. */
export function lazyPanel(loader: AsyncComponentLoader): Component {
  return defineAsyncComponent({ loader, loadingComponent: SkeletonBlock, delay: 80 })
}

/** Lazy dialog: no placeholder (the dialog simply transitions in once its chunk is loaded). */
export function lazyDialog(loader: AsyncComponentLoader): Component {
  return defineAsyncComponent(loader)
}
