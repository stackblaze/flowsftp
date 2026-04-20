import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const shared = resolve(__dirname, 'src/shared')
const rendererSrc = resolve(__dirname, 'src/renderer/src')
const materialIconsSrc = resolve(
  __dirname,
  'node_modules/vscode-material-icons/generated/icons'
)

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
      // Self-host the VS Code Material file/folder SVGs at /material-icons/.
      // They live in node_modules under vscode-material-icons/generated/icons
      // and are referenced at runtime via getIconUrlForFilePath(path, '/material-icons').
      // Both `dev` (served by Vite) and `build` (copied into out/renderer)
      // resolve the URL the same way, so no environment-specific URL logic.
      viteStaticCopy({
        targets: [
          {
            src: `${materialIconsSrc}/*.svg`,
            dest: 'material-icons'
          }
        ]
      })
    ]
  }
})
