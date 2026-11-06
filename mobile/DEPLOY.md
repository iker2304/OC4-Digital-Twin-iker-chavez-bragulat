# Despliegue: local, Docker y VPS

La app es **un solo proceso Node**: sirve la SPA compilada (`dist/`) y unos pocos
endpoints `/api` de telemetría. La inferencia corre en el navegador, así que el
servidor no necesita GPU ni Python.

## Requisitos

| Para | Necesitas |
|---|---|
| desarrollo | Node 22 |
| imagen / producción | Docker |
| publicarla en un subpath | nginx, Caddy o el proxy que uses |

## 1. Local, sin Docker

```bash
npm install          # dependencias + runtime de ORT en public/ort (postinstall)
npm run dev          # http://localhost:5273
```

El servidor de la API es opcional; sin él la app funciona pero no hay selector
de modelos ni histórico del bench:

```bash
npm run server       # API en :8787 (o el PORT de tu .env.local)
npm start            # build + SPA y API en un único proceso
```

> En `dev` el runtime local de ORT no se puede usar (necesita worker y
> `crossOriginIsolated`), así que la app cae al CDN. Se nota en la tarjeta del
> modelo: `runtime CDN · hilo principal`. En la imagen de producción debe decir
> `runtime local · aislado · worker`.

## 2. Docker en local

```bash
docker build -t oc4-mobile:latest .
docker run --rm -p 8790:8790 oc4-mobile:latest
# → http://localhost:8790
```

La imagen es multi-stage: compila con Node 22 y todas las devDependencies, y en
la etapa final solo instala `express` y `compression`. El resto de `dependencies`
(react, three, drei, onnxruntime-web…) son de compilación y sumaban ~150 MB.

### Lo que se decide en el build, no en runtime

| Argumento | Por defecto | Para qué |
|---|---|---|
| `PUBLIC_BASE` | `/oc4-dt-mobile/` | subpath público; se hornea en el HTML y en todas las URLs que el cliente construye |
| `VITE_DEFAULT_MODEL_URL` | `/models/yolo-pose-n-200.onnx` | modelo que se carga solo al entrar (nano 200 ft4, fp32) |

```bash
docker build \
  --build-arg PUBLIC_BASE=/mi-app/ \
  --build-arg VITE_DEFAULT_MODEL_URL=/models/otro-modelo-int8.onnx \
  -t oc4-mobile:latest .
```

Sin `PUBLIC_BASE` la base es `/` y la app solo funciona en la raíz del dominio.
En Git Bash escríbelo **sin** la barra inicial (`PUBLIC_BASE=mi-app`): MSYS
convierte `/algo` en `C:/Program Files/Git/algo`.

## 3. VPS

No hace falta nada especial: `docker run` y, si lo quieres bajo un subpath, un
proxy delante que **recorte el prefijo** hacia el contenedor.

```bash
# en el servidor
docker run -d --name oc4-dt-mobile --restart unless-stopped \
  -p 127.0.0.1:8790:8790 \
  -v oc4-bench-data:/data -e DATA_DIR=/data \
  oc4-mobile:latest
```

`-p 127.0.0.1:8790` a propósito: el puerto no se expone a Internet, solo lo ve el
proxy. El volumen es lo que conserva el histórico del bench entre despliegues
(el contenedor se recrea en cada uno).

Para llevarte la imagen sin registry, desde tu máquina:

```bash
docker save oc4-mobile:latest | gzip -1 | ssh <usuario>@<host> 'gunzip | docker load'
```

O con `docker compose up -d --build` en esta carpeta (mismos argumentos de build).

### nginx recortando el prefijo

```nginx
# /oc4-dt-mobile/api/ → 127.0.0.1:8790/api/  (las barras finales hacen el recorte)
location /oc4-dt-mobile/api/ {
    proxy_pass http://127.0.0.1:8790/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # el stream de telemetría es SSE
    proxy_read_timeout 3600s;
}

location /oc4-dt-mobile/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

No toques `COOP`/`COEP`: los pone el servidor de la app y son los que activan
`crossOriginIsolated` (WASM multi-hilo). nginx los reenvía tal cual.

### Si el servidor es compartido

Este bloque solo **añade** un `location`; no cambia el resto del sitio. Aun así:

```bash
cp /etc/nginx/sites-enabled/<tu-sitio> /root/nginx-backups/<tu-sitio>-$(date +%F-%H%M)
nginx -t && systemctl reload nginx      # reload, nunca restart
```

Y después comprueba que las demás rutas del dominio siguen respondiendo: parar y
arrancar nginx deja sin servicio a todo lo que haya detrás durante un instante.

## Qué no está en el repo

| Asset | Tamaño | Cómo se obtiene |
|---|---|---|
| `public/models/*.onnx` (salvo el modelo por defecto) | 3–40 MB cada uno | `npm run sync:models`, o exportando con `scripts/export-onnx.py` |
| `public/models/*.glb`, `*.fbx` (salvo `OC4.glb`) | 9–18 MB | `npm run sync:models` (vienen del repo principal) |
| `public/ort/` | ~41 MB | `npm install` (postinstall) o `npm run sync:ort` |
| `models/*.pt`, `models/*.zip` | cientos de MB | pesos crudos, no se versionan |

Sí están versionados **`OC4.glb`** (el gemelo 3D), **`yolo-pose-n-200.onnx`** (el
modelo por defecto, nano 200 ft4 en fp32, 11,2 MB), **`yolo-pose-s-coco-640.onnx`**
(39,3 MB, el de mejor rotor) y **`yolo-pose-n-640-int8.onnx`** (3,3 MB, la
variante rápida para móvil). Con eso un clon arranca sin nada más que
`npm install`. Si falta el `.glb`, la escena no se rompe: dibuja una plataforma
procedural y lo avisa. Si falta el modelo, la app abre igual y te pide uno desde
la interfaz.

## Verificar un despliegue

```bash
curl -sI https://<host>/oc4-dt-mobile/ | head -5      # 200 + COOP/COEP
curl -s https://<host>/oc4-dt-mobile/api/health         # JSON con el host real
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
     https://<host>/oc4-dt-mobile/models/yolo-pose-n-200.onnx
```

Recuerda que con el prefijo recortado, **desde dentro del servidor** la ruta
correcta es `http://127.0.0.1:8790/model-info/index.json` (sin `/oc4-dt-mobile`);
con el prefijo delante, nginx devuelve el `index.html` de la SPA.
