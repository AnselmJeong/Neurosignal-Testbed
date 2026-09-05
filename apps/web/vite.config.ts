import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Public/LAN requests use the same credentials as the HTTPS remote-access server.
// Local development remains usable without a login; forwarded headers never grant access.
function remoteAccessAuth(): Plugin {
  return {
    name: 'neurosignal-remote-access-auth',
    configureServer(server) {
      const directory = fileURLToPath(new URL('../../.remote-access/', import.meta.url))
      const file = `${directory}/credentials.json`
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      if (!existsSync(file)) {
        writeFileSync(file, JSON.stringify({
          username: 'neurosignal', password: randomBytes(24).toString('base64url'),
        }), { flag: 'wx', mode: 0o600 })
      }
      chmodSync(file, 0o600)
      const credentials = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof credentials.username !== 'string' || !credentials.username
        || typeof credentials.password !== 'string' || credentials.password.length < 24) {
        throw new Error('Invalid remote-access credentials; refusing to open the network listener.')
      }
      const expected = createHash('sha256')
        .update(`${credentials.username}:${credentials.password}`).digest()
      server.middlewares.use((request, response, next) => {
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
        if (local) return next()
        const header = request.headers.authorization ?? ''
        const supplied = createHash('sha256').update(Buffer.from(header.slice(6), 'base64')).digest()
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('X-Frame-Options', 'DENY')
        if (!header.toLowerCase().startsWith('basic ') || !timingSafeEqual(expected, supplied)) {
          response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NeuroSignal"' })
          response.end('Sign in to NeuroSignal.')
          return
        }
        const origin = request.headers.origin
        if (origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET')) {
          let matchingOrigin = false
          try { matchingOrigin = new URL(origin).host === request.headers.host } catch { /* Reject malformed origins. */ }
          if (!matchingOrigin) {
            response.writeHead(403)
            response.end('Cross-origin requests are not allowed.')
            return
          }
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [remoteAccessAuth(), react()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    allowedHosts: ['anselmjeong.synology.me'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
