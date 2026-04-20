import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { normalizePath } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const shared = resolve(__dirname, 'src/shared')
const rendererSrc = resolve(__dirname, 'src/renderer/src')

/** Forward-slash path so fast-glob sees `…/icons/*.svg` on Windows CI (backslashes break copy). */
const materialIconsGlob = `${normalizePath(
  resolve(__dirname, 'node_modules/vscode-material-icons/generated/icons'),
)}/*.svg`

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': shared }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': shared }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': rendererSrc,
        '@shared': shared
      }
    },
    plugins: [
      vue(),
      // Self-host Material file/folder SVGs under out/renderer/material-icons/.
      // Renderer code uses `./material-icons` so img src works under file://
      // (absolute /material-icons would resolve to the filesystem root).
      viteStaticCopy({
        targets: [
          {
            src: materialIconsGlob,
            dest: 'material-icons'
          }
        ]
      })
    ]
  }
})
