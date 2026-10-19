import { createApp } from 'vue'
import SystemwidePopup from './SystemwidePopup.vue'

/** The floating popup of «مِزَاج في أي برنامج»: a tiny app, not the full editor. */
export function mountPopup(): void {
  createApp(SystemwidePopup).mount('#app')
}
