# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# OC4 Digital Twin · cliente móvil (estático + servidor de telemetría)
#
# La app es un único proceso Node: sirve `dist/` (la SPA ya compilada) y unos
# pocos endpoints `/api` de telemetría. No necesita backend aparte: la
# inferencia corre en el dispositivo.
#
# Se publica bajo un subpath (`/oc4-dt-mobile/`), y eso se decide **en el
# build**: `PUBLIC_BASE` se hornea en el HTML y en todas las URLs que el cliente
# construye en tiempo de ejecución (modelos, runtime de ORT, API).
# ---------------------------------------------------------------------------

FROM node:22-alpine AS build
WORKDIR /app

# Capa de dependencias separada: solo se invalida si cambian los manifests.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Subpath público. Se normaliza en vite.config.ts (con o sin barras).
ARG PUBLIC_BASE=/oc4-dt-mobile/
ENV PUBLIC_BASE=${PUBLIC_BASE}
# Modelo que se carga solo al entrar.
#
# Ojo: este `ENV` **pisa** el `.env.local` durante el `vite build` de la imagen
# (`.env.local` ni siquiera se copia, está en `.dockerignore`), así que el modelo
# por defecto de producción se decide aquí.
#
# Nano 200 fine-tuned through `nano200_coco_ft4`; fp32 is the canonical default.
ARG VITE_DEFAULT_MODEL_URL=/models/yolo-pose-n-200.onnx
ENV VITE_DEFAULT_MODEL_URL=${VITE_DEFAULT_MODEL_URL}

RUN npm run build

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8790 \
    HOST=0.0.0.0 \
    SERVE_DIST=1

# El servidor solo importa `express` y `compression`; el resto de `dependencies`
# (react, three, drei, onnxruntime-web…) son de compilación y arrastran ~150 MB
# de transitivas. Se instala un árbol limpio con las **versiones declaradas** en
# el package.json del proyecto, sin lockfile: 950 MB → ~290 MB.
COPY package.json ./
RUN node -e "const p=require('./package.json');const deps={express:p.dependencies.express,compression:p.dependencies.compression};require('fs').writeFileSync('package.json',JSON.stringify({name:p.name+'-server',private:true,type:p.type||'module',dependencies:deps},null,2));console.log('runtime deps:',deps)" \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server




# El contenedor está sano si responde el healthcheck de la API.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
