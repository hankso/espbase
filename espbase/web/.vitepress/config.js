import { statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { name as title } from '../package.json'

import { defineConfig } from 'vitepress'
import { withPwa } from '@vite-pwa/vitepress'

export default withPwa(defineConfig(() => {
    const base = resolve(import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url)))
    let dist = join(base, '../../data/doc')
    if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory())
        dist = join(base, '../dist/doc')
    return {
        vite: {
            server: {
                host: '0.0.0.0',
                port: 5174,
            },
            build: {
                rollupOptions: {
                    external: ['vue', 'vue/server-renderer'], // FIXME: see issue #2713
                },
            },
        },
        title,
        base: './',
        srcDir: '../docs',
        outDir: dist,
        pwa: {
            outDir: dist,
            registerType: 'autoUpdate',
            injectRegister: 'inline',
            experimental: {
                includeAllowlist: true,
            },
        },
        lastUpdated: true,
        themeConfig: {
            footer: {
                message: 'Released under the MIT License.',
                copyright: 'Copyright 2024-PRESENT Hankso',
            },
            search: {
                provider: 'local',
            },
            sidebar: [
                {
                    text: 'Overview',
                    items: [
                        { text: 'Build system', link: '/build' },
                        { text: 'Configuration', link: '/config' },
                        { text: 'Console', link: '/console' },
                        { text: 'Hardware', link: '/drivers' },
                        { text: 'File system', link: '/filesys' },
                        { text: 'Network', link: '/network' },
                        { text: 'HTTP Server', link: '/server' },
                        { text: 'Bluetooth', link: '/btmode' },
                        { text: 'USB & HID', link: '/hidtool' },
                        { text: 'AVI Tool', link: '/avitool' },
                        { text: 'Display', link: '/display' },
                        { text: 'OTA Update', link: '/update' },
                        { text: 'Web pages', link: '/webpage' },
                    ],
                },
            ],
            socialLinks: [
                {
                    icon: 'github',
                    link: 'https://github.com/hankso/esp32/tree/main/espbase',
                },
            ],
        },
    }
}))
