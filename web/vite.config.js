// Plugins
import vue from '@vitejs/plugin-vue'
import prismjs from 'vite-plugin-prismjs'
import autoimport from 'unplugin-auto-import/vite'
import components from 'unplugin-vue-components/vite'
import ServeStatic from 'vite-plugin-serve-static'
import VueDevTools from 'vite-plugin-vue-devtools'
import { visualizer } from 'rollup-plugin-visualizer'
import { compression } from 'vite-plugin-compression2'
import vuetify, { transformAssetUrls } from 'vite-plugin-vuetify'
import { pythonServer } from './src/plugins/vite'

// Utilities
import { execSync } from 'node:child_process'
import { constants } from 'node:zlib'
import { statSync, globSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { join, resolve, relative } from 'node:path'

import { defineConfig } from 'vite'

export default defineConfig(({ command }) => {
    const base = resolve(import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url)))
    const port = 5172                               // python api server
    let dist = join(base, '../data/www')
    if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory())
        dist = join(base, './dist/www')
    let info = undefined
    if (command === 'build') {
        info = {
            NODE_JS: process.versions.node,
            BUILD_OS: `${process.platform}-${process.arch}`,
            BUILD_TIME: new Date().toLocaleString(),
        }
        try { info['SOURCE'] = `${execSync('git describe --tags --always')}` } catch {}
    }
    return {
        build: {
            outDir: dist,
            assetsDir: 'assets',
            emptyOutDir: true,
            reportCompressedSize: false,
            rollupOptions: {
                output: {
                    manualChunks(id) {
                        if (!id.includes('node_modules')) return
                        if (id.includes('vuetify')) return 'vuetify'
                        if (id.includes('axios')) return 'axios'
                    }
                },
            },
        },
        server: {
            host: '0.0.0.0',
            port: port + 1,                         // 5173
            proxy: {
                '/api': {
                    target: `http://localhost:${port}`,
                    changeOrigin: true,
                    secure: false,
                },
            },
        },
        define: {
            'process.env': {
                PROJECT_VERSION: process.env.npm_package_version,
                PROJECT_NAME: process.env.npm_package_name,
                API_SERVER: port,
                BUILD_INFO: info,
                VITE_PATH: base,
                VITE_CMD: command,
            },
        },
        plugins: [
            vue({
                template: { transformAssetUrls },   // add more types
            }),
            vuetify(),
            prismjs({
                languages: [
                    'c',
                    'js',
                    'cpp',
                    'css',
                    'csv',
                    'json',
                    'bash',
                    'cmake',
                    'markup',
                ],
                plugins: [
                    'previewers',
                    'autolinker',
                    'inline-color',
                    'show-invisibles',
                ],
                theme: 'default',
                css: true,
            }),
            autoimport({
                imports: ['vue', 'vue-router', 'vue-i18n'],
            }),
            components({
                dts: false,
            }),
            visualizer({
                template: 'treemap',                // sunburst|network|raw-data|list
                emitFile: dist.startsWith(base),
                brotliSize: true,                   // gzipSize: true,
            }),
            compression({
                include: /\.(md|js|css|xml|html|json)$/,
                algorithms: [
                    'gzip',
                    ['br', { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }],
                ],
                logLevel: 'silent',
                deleteOriginalAssets: true,
                artifacts: () => globSync(join(base, '../docs/**/*.md')).map(src => ({
                    src, replace: () => join(dist, '../doc', relative(join(base, '../docs'), src))
                })),
            }),
            ServeStatic({
                rules: [
                    {
                        pattern: /^\/docs\/(.*\.md)$/,
                        resolve: ([, match]) => join(base, '../docs', match),
                    },
                ],
            }),
            VueDevTools(),
            pythonServer({ port, entry: join(base, '../helper.py') }),
        ],
        resolve: {
            alias: {
                '@': join(base, './src'),
            },
        },
    }
})
