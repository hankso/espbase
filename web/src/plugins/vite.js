// Custom Vite Plugins

// Utilities
import fs from 'node:fs'
import zlib from 'node:zlib'
import { spawn } from 'node:child_process'
import { join, relative } from 'node:path'

// Colorful logging
try {
    var pc = (await import('picocolors')).default
} catch {
    let AnsiSGR = () => str => '' + str
    if (
        process.stdout.isTTY &&
        process.env.TERM !== 'dumb' &&
        process.env.FORCE_COLOR !== '0' &&
        !process.env.NODE_DISABLE_COLORS &&
        !process.env.NO_COLOR
    ) {
        AnsiSGR = (start, end) => {
            const open = `\x1b[${start}m`
            const close = `\x1b[${end}m`
            const regex = new RegExp(`\\x1b\\[${end}m`, 'g')
            return str => open + ('' + str).replace(regex, open) + close
        }
    }
    pc = {
        bold: AnsiSGR(1, 22),
        dim: AnsiSGR(2, 22),
        green: AnsiSGR(32, 39),
        cyan: AnsiSGR(36, 39),
        gray: AnsiSGR(90, 39),
    }
}

class PythonServer {
    constructor(
        port = 8080,
        host = '0.0.0.0',
        entry = 'main.py',
        verbose = false,
        command = 'python'
    ) {
        this.proc = this.pid = null
        this.port = port
        this.host = host
        this.verb = verbose
        this.addr = `${host.replace('0.0.0.0', 'localhost')}:${port}`
        this.args = [command, '-u', entry, 'serve', '-H', host, '-P', port]
        if (!verbose) this.args.splice(3, 0, '--quiet')
    }
    log() {
        // print timestamp and colorful string same like vite
        console.log(
            pc.dim(new Date().toLocaleTimeString()),
            pc.cyan(pc.bold('[psrv]')),
            this.pid ? `[${this.pid}]` : '',
            ...arguments
        )
    }
    logln(str) {
        str.split('\n').forEach(line => line && this.log(line))
    }
    info() {
        if (this.verb) this.log(...arguments)
    }
    start() {
        if (this.proc) return this

        // DO NOT use `exec` on windows system
        this.proc = spawn(this.args[0], this.args.slice(1))
        this.pid = this.proc.pid

        this.proc.on('exit', code => {
            this.info(`Python Server exit(${code || 0})`)
            this.proc = this.pid = null
        })
        this.proc.on('error', err => console.log(`Error: ${err}`))
        this.proc.stdout.on('data', b => this.logln(String(b).trim()))
        this.proc.stderr.on('data', b => this.logln(String(b).trim()))

        this.info('Python Server start')
        return this
    }
    close() {
        if (!this.proc) return this
        this.info('Python Server killed')
        this.proc.kill()
        this.proc = null
        return this
    }
    toString() {
        let [host, port] = this.addr.split(':')
        return [
            pc.green('  \u279c '),
            pc.bold('Python: '),
            pc.cyan(`http://${host}:${pc.bold(port)}`),
            pc.green(`(PID ${this.pid})`),
        ].join(' ')
    }
}

export function pythonServer(options = {}) {
    var pserver
    return {
        name: 'python-api-server',
        apply: 'serve',
        enforce: 'pre',
        buildStart() {
            pserver && pserver.start()
        },
        buildEnd() {
            pserver && pserver.close()
        },
        configResolved(resolvedConfig) {
            pserver = new PythonServer(
                options.port ?? resolvedConfig.server.port - 1,
                options.host ?? resolvedConfig.server.host,
                options.entry ?? 'main.py',
                options.verbose ?? false,
                options.command ?? 'python'
            )
        },
        configureServer(server) {
            let printUrls = server.printUrls
            server.printUrls = () => {
                if (pserver && pserver.proc)
                    server.config.logger.info(pserver.toString())
                printUrls()
            }
        },
    }
}

export function compression(root) {
    return config => {
        if (!fs.existsSync(config.outDir)) return
        let dist = relative(root, config.outDir).replaceAll('\\', '/')
        if (!dist.endsWith('/')) dist += '/'
        let files = []
        ;(function walk(dir) {
            const ents = fs.readdirSync(dir, { withFileTypes: true })
            for (const ent of ents) {
                const full = join(dir, ent.name)
                if (ent.isDirectory()) {
                    walk(full)
                } else if (/\.(md|js|css|json|html|xml|txt)$/i.test(ent.name)) {
                    const src = fs.readFileSync(full)
                    const dst = zlib.brotliCompressSync(src)
                    fs.writeFileSync(full + '.br', dst)
                    fs.unlinkSync(full)
                    files.push([
                        relative(config.outDir, full + '.br').replaceAll(
                            '\\',
                            '/'
                        ),
                        (src.length / 1e3).toFixed(2),
                        (dst.length / 1e3).toFixed(2),
                    ])
                }
            }
        })(config.outDir)
        let [nlen, slen, dlen] = files.reduce(
            (acc, cur) => {
                cur.map((s, i) => (acc[i] = Math.max(acc[i], s.length)))
                return acc
            },
            [0, 0, 0]
        )
        for (let [name, sstr, dstr] of files) {
            config.logger.info(
                pc.dim(dist) +
                    pc.green(name.padEnd(nlen + 1)) +
                    pc.dim(`${sstr.padStart(slen)} kB │ br: `) +
                    pc.dim(`${dstr.padStart(dlen)} kB`)
            )
        }
    }
}
