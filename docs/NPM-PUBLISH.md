# NPM Publishing Guide / Guía de publicación en NPM

`@pired/sap-fiori-mcp-server` está preparado para publicarse en NPM. El paquete ya incluye:
- `bin` (`sap-fiori-mcp` y `sap-fiori-mcp-server`) para uso con `npx @pired/sap-fiori-mcp-server`
- `files` con `dist/`, `docs/`, `examples/` (proyecto demo bookshop incluido)
- `prepublishOnly` que ejecuta typecheck + build + tests (todos los tests deben pasar)
- `publishConfig.access: public` (necesario para paquetes con scope)

## Requisito previo: el scope `@pired`

Un paquete con scope solo puede publicarse si **eres propietario del scope** en npmjs.com. El scope `pired` corresponde a:
- tu **nombre de usuario** npm llamado `pired`, **o**
- una **organización** npm llamada `pired` (creable gratis en https://www.npmjs.com/org/create — selecciona "Unlimited public packages").

Comprueba que el scope te pertenece:
```bash
npm whoami          # debe devolver "pired" (o tu usuario miembro de la org pired)
npm org ls pired    # si es organización
```

> Si el scope `pired` ya pertenece a otra cuenta/org, no podrás publicar bajo ese scope. En ese caso elige otro (p. ej. `@pired-dev/...`) y actualiza `name` en `package.json`.

## Pasos para publicar

```bash
cd sap-fiori-mcp-server

# 1. Iniciar sesión en npm (requiere cuenta en npmjs.com)
npm login

# 2. (Opcional) Verificar el contenido del paquete sin publicar
npm publish --dry-run

# 3. Publicar (publishConfig.access: public ya está configurado,
#    pero pasar la flag no hace daño)
npm publish --access public
# Si tu cuenta tiene 2FA activado:
npm publish --access public --otp=123456
```

## Publicar con un token de automatización (CI/CD)

```bash
export NPM_TOKEN=npm_xxxxxxxxxxxxxxxxxxxxxxxx
# npm usa el token si tu ~/.npmrc contiene:
#   //registry.npmjs.org/:_authToken=${NPM_TOKEN}
npm publish --access public
```

Para GitHub Actions:
```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    registry-url: "https://registry.npmjs.org"
- run: npm ci && npm publish --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Verificar la publicación

```bash
npm view @pired/sap-fiori-mcp-server version
npx @pired/sap-fiori-mcp-server@latest --version
```

## Instalación desde tarball local (antes de publicar)

El tarball generado por `npm pack` para un paquete con scope se llama
`pired-sap-fiori-mcp-server-1.1.0.tgz` (sin la `@`):

```bash
npm install -g pired-sap-fiori-mcp-server-1.1.0.tgz
sap-fiori-mcp --version
```

## Notas

- La versión se mantiene en `package.json` y en `src/config.ts` (`SERVER_VERSION`) — súbelas juntas.
- Para releases futuras: `npm version patch|minor|major` crea el bump y luego `npm publish --access public`.
- Los comandos `bin` no pueden llevar scope: siguen siendo `sap-fiori-mcp` y `sap-fiori-mcp-server`.
- Si añades un repositorio Git, agrégalo como `"repository"` en `package.json` para que npm muestre el enlace.
