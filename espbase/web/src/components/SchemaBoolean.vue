<template>
    <v-switch
        inset
        color="primary"
        true-value="1"
        false-value="0"
        hide-details
        v-model="proxy"
    ></v-switch>
</template>

<script setup>
import { type, parseBool } from '@/utils'

const props = defineProps({
    value: {
        type: [String, Boolean],
        required: true,
    },
    schema: {
        type: Object,
        default: undefined,
    },
    update: {
        type: Function,
        default: () => {},
    },
})

const isBoolean = computed(
    () => (props.schema?.type ?? type(props.value)) === 'boolean'
)

const proxy = computed({
    get: () => (parseBool(props.value) ? '1' : '0'),
    set: val => props.update(isBoolean.value ? parseBool(val) : val),
})
</script>

<style scoped>
:deep(.v-selection-control) {
    justify-content: end;
}
</style>
