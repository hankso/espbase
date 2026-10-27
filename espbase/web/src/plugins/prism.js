if (typeof window !== 'undefined') {
    window.Prism = window.Prism || {}
    window.Prism.manual = true
}

import Prism from 'prismjs'

if (typeof window !== 'undefined' && import.meta.env.MODE !== 'development') {
    delete window.Prism
}

export default Prism
