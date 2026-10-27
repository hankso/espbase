<template>
    <nav class="bg-surface border rounded-lg px-4 py-3 position-sticky">
        <li class="border-b mb-1">
            <a
                href="#"
                class="text-decoration-none text-primary"
                @click.prevent="scrollTo()"
            >
                Return to top ↑
            </a>
        </li>
        <li
            v-for="([, text, depth], id) in outline"
            :class="`pl-${(depth - 1) * 4}`"
            :key="id"
        >
            <a
                :href="`#${id}`"
                :class="active == id ? 'text-primary' : 'text-grey'"
                class="text-decoration-none"
                @click.prevent="scrollTo(id)"
            >
                {{ text }}
            </a>
        </li>
    </nav>
    <v-sheet class="pa-6 border rounded-lg">
        <article class="markdown-body" v-html="html" ref="article" />
    </v-sheet>
</template>

<script setup>
import 'github-markdown-css/github-markdown.css'

// import fm from 'front-matter'
// import { sanitize } from 'dompurify'
import { marked } from 'marked'
import { getGuide } from '@/apis'
import Prism from '@/plugins/prism'

const html = ref('')
const route = useRoute()
const notify = inject('notify', console.log)
const config = {
    lineNumber: true,
    showOutline: true,
    showLanguage: true,
}
let observer = null
const active = ref('')
const outline = ref({}) // {id: [index, text, depth]}
const article = useTemplateRef('article')

function scrollTo(id) {
    let elem = id && document.getElementById(id)
    if (elem) {
        elem.scrollIntoView({ behavior: 'smooth', block: 'center' })
    } else {
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }
}

function observe() {
    observer?.disconnect()
    if (!config.showOutline || !article.value) return
    observer = new IntersectionObserver(
        entries => {
            let visible = entries
                .filter(e => e.isIntersecting)
                .sort(
                    (a, b) =>
                        a.boundingClientRect.top - b.boundingClientRect.top
                )
            if (visible.length) active.value = visible[0].target.id
        },
        { rootMargin: '0px 0px -50% 0px', threshold: 0 }
    )
    article.value
        .querySelectorAll('h1, h2, h3')
        .forEach(h => observer.observe(h))
}

marked.use({
    gfm: true,
    breaks: true,
    hooks: {
        preprocess(markdown) {
            if (config.showOutline) outline.value = {}
            return markdown
            /*
            let { attrs, body } = fm(markdown)
            for (let prop in attrs) {
                if (prop in this.options)
                    this.options[prop] = attrs[prop]
            }
            return body
            */
        },
        // postprocess: sanitize,
    },
    renderer: {
        link({ text, href }) {
            if (!href || href.startsWith('http')) return false
            let url = new URL(href, `http://x/${route.hash.slice(1)}`)
            return `<a href="#${url.pathname.slice(1)}">${text}</a>`
        },
        code({ text, lang }) {
            if (!Prism.languages[lang]) lang = 'txt'
            let html = Prism.highlight(text, Prism.languages[lang], lang)
            if (config.lineNumber) {
                let cnt = (html.match(/\n(?!$)/g) || []).length + 2
                let elem = '<span class="token comment"></span>'
                let line = new Array(cnt).join(elem)
                html += `<span aria-hidden="true" class="line">${line}</span>`
            }
            if (config.showLanguage)
                html += `<span class="token comment lang">${lang}</span>`
            return `<pre><code class="language-${lang}">${html}</code></pre>`
        },
        heading({ text, depth }) {
            if (!config.showOutline || depth > 3) return false
            let escaped =
                text
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}-]/gu, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '') || 'section'
            if (escaped in outline.value)
                escaped += '-' + outline.value[escaped][0]++
            outline.value[escaped] = [0, text, depth]
            return `<h${depth} id="${escaped}">${text}</h${depth}>`
        },
    },
})

watchPostEffect(() => {
    let path = route.hash.replace(/^[#./]*|\.(md|html)$/gi, '')
    getGuide(`${path + (!path || path.endsWith('/') ? 'index' : '')}.md`)
        .then(resp => {
            html.value = marked.parse(resp.data)
            if (config.showOutline) nextTick().then(observe)
        })
        .catch(({ message }) => notify(message))
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
:deep(article) {
    color: rgb(var(--v-theme-on-background));
    background-color: rgb(var(--v-theme-surface));
    transition: color 0.5s;
    font-family: var(--font-text);
    line-height: 1.6;
    a {
        font-weight: 500;
        text-decoration: underline;
        &:hover {
            color: rgb(var(--v-theme-primary-darken-1));
        }
    }
    h2 {
        margin: 1em 0;
        padding: 1em 0 0 0;
        border-top: 1px solid var(--border-color);
        border-bottom: none;
    }
    tr {
        background-color: rgb(var(--v-theme-surface));
    }
    pre,
    code,
    th,
    tr:nth-child(2n) {
        color: rgb(var(--v-theme-on-background));
        background-color: rgb(var(--v-theme-surface-light));
        transition: color 0.5s;
    }
    code {
        font-family: var(--font-code);
        text-shadow: none;
        &.language-txt {
            font-weight: 350;
        }
    }
    :not(pre) code,
    a {
        color: rgb(var(--v-theme-primary));
    }
    .token.operator {
        background: none;
    }
    pre:has(.line),
    pre:has(.lang) {
        padding-left: 3.8em;
        code {
            display: block;
            position: relative;
        }
        .line {
            position: absolute;
            top: 0;
            left: -3.8em;
            width: 3em;
            border-right: 1px solid var(--border-color);
            span {
                counter-increment: line 1;
                &::before {
                    content: counter(line);
                    display: block;
                    text-align: right;
                    padding-right: 0.8em;
                }
            }
        }
        .lang {
            position: absolute;
            top: 0;
            right: 0;
            border-radius: 0.8em;
            padding: 0.1em 0.4em;
        }
    }
}

nav {
    top: 4em;
    z-index: 999;
    list-style: none;
}
</style>
