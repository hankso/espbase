<template>
    <div class="code-jar">
        <div ref="elem" :class="`codejar-editor lang-${language}`"></div>
    </div>
</template>

<script setup>
import Prism from '@/plugins/prism'
import { type, debounce } from '@/utils'

import { CodeJar } from 'codejar'
import { withLineNumbers } from 'codejar-linenumbers'

var editor = null

const elem = ref(null)

const text = defineModel({
    type: String,
    default: 'Type in your code here',
})

const props = defineProps({
    language: {
        type: String,
        default: '',
    },
    readonly: Boolean,
    highlight: {
        type: [Function, String, Boolean],
        default: true,
    },
    lineNumber: Boolean,
})

// see https://github.com/antonmedv/codejar
const config = {
    tab: ' '.repeat(4),
    spellcheck: true,
    catchTab: true,
}

function rainbow(ch, i) {
    let r = Math.round(Math.sin(0.01 * i + 0) * 127 + 128)
    let g = Math.round(Math.sin(0.01 * i + (2 * Math.PI) / 3) * 127 + 128)
    let b = Math.round(Math.sin(0.01 * i + (4 * Math.PI) / 3) * 127 + 128)
    return `<span style="color: rgb(${r}, ${g}, ${b})">${ch}</span>`
}

const highlighters = {
    prism: Prism.highlightElement,
    lolcat: e => (e.innerHTML = e.textContent.split('').map(rainbow).join('')),
}

const highlight = computed(() => {
    // parse highlight from user provided props
    let func = highlighters[props.highlight] || (() => {})
    if (type(props.highlight) === 'function') {
        func = props.highlight
    } else if (type(props.highlight) === 'boolean' && props.highlight) {
        func = highlighters['prism'] // default one
    }
    return props.lineNumber ? withLineNumbers(func) : func
})

function setReadonly(val) {
    if (!toValue(elem)) return // not ready yet
    elem.value.setAttribute('contenteditable', val ? false : 'plaintext-only')
}

function destroy() {
    editor?.destroy()
    let e = toValue(elem) // hotfix for codejar-linenumbers:exit
    if (e?.parentNode.classList.contains('codejar-wrap')) {
        e.style.paddingLeft = ''
        e.style.whiteSpace = 'pre-wrap'
        e.parentNode.replaceWith(e)
    }
    return e
}

function refresh() {
    if (!destroy()) return // not ready yet
    editor = CodeJar(toValue(elem), toValue(highlight), config)
    editor.updateCode(toValue(text))
    editor.onUpdate(debounce(() => (text.value = editor.toString())))
    setReadonly(props.readonly)
}

watch(highlight, refresh)

watch(() => props.readonly, setReadonly)

watch(text, val => {
    if (editor && editor.toString() !== val) {
        let pos
        try {
            pos = editor.save()
        } catch {
            pos = null
        }
        editor.updateCode(val) // this will trigger editor.onUpdate
        pos && editor.restore(pos)
    }
})

watchPostEffect(() => {
    // highlight when class `lang-xxx` is applied to DOM
    if (props.language && editor) editor.updateCode(editor.toString())
})

onMounted(refresh)
onBeforeUnmount(destroy)
</script>

<style scoped>
.codejar-editor {
    height: 100%;
    padding-left: 8px;
    font-family: var(--font-code);
    &[contenteditable='false'] {
        cursor: not-allowed;
    }
    :deep(.token:before) {
        opacity: 0.4;
    }
}

:deep(.codejar-wrap) {
    height: 100%;
    .codejar-linenumbers-inner-wrap {
        height: 100%;
        z-index: 1;
        position: absolute;
        border-right: 1px solid var(--border-color);
        .codejar-linenumbers {
            background-color: rgb(var(--v-theme-background)) !important;
            .codejar-linenumber {
                color: rgb(var(--v-theme-on-background)) !important;
                text-align: right;
                padding-right: 8px;
            }
        }
    }
}
</style>
