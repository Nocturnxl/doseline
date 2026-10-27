import { app } from 'electron'

export const is = {
  get packaged(): boolean {
    return app.isPackaged
  },
  get dev(): boolean {
    return !app.isPackaged
  },
}

export const APP_ID = 'com.doseline.app'
