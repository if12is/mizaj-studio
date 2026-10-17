import { ApiClient } from './client'
import { notify } from './toast'
import { useSidecarStore } from '@renderer/stores/sidecar'

let client: ApiClient | null = null

/** Shared client; base URL comes from the sidecar store, errors show message_ar. */
export function useApi(): ApiClient {
  if (!client) {
    const sidecar = useSidecarStore()
    client = new ApiClient({
      getBaseUrl: () => sidecar.baseUrl,
      onError: (e) => notify(e.messageAr)
    })
  }
  return client
}
