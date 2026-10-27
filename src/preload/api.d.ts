import type { DoselineApi } from '../shared/api'

declare global {
  interface Window {
    doseline: DoselineApi
  }
}

export {}
