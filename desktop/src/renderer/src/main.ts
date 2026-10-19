import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'
import './assets/motion.css'

// The same page also serves the small floating popup of «مِزَاج في أي برنامج» (?popup=1).
if (new URLSearchParams(location.search).get('popup') === '1') {
  void import('./popup/mountPopup').then((m) => m.mountPopup())
} else {
  createApp(App).use(createPinia()).mount('#app')
}
