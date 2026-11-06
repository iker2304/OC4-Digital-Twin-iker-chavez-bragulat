/**
 * Diccionario de referencia (castellano).
 *
 * Todas las claves que existen aquí deben existir en `en.ts` y `ca.ts`: el tipo
 * `Dict` se deriva de este objeto, así que si falta una traducción TypeScript
 * avisa al compilar.
 */
export const es = {
    'lang.name': 'Castellano',
    'lang.switch': 'Idioma',

    'nav.skip': 'Saltar',
    'nav.brand': 'Digital Twin · Mobile',

    'hero.kicker': 'OC4',
    'hero.title': 'Live Digital Twin',
    'hero.text.before': 'Apunta con la cámara del móvil a la plataforma eólica flotante y verás el gemelo digital superpuesto, con la detección corriendo ',
    'hero.text.strong': 'en el propio dispositivo',
    'hero.text.after': ': sin servidores, sin subir vídeo a ningún sitio.',
    'hero.imageAlt': 'Fotograma del vídeo con la detección superpuesta: caja y keypoints de la plataforma y del rotor.',
    'hero.scroll': 'Desliza',

    'concept.badge': 'La idea',
    'concept.title': 'Realidad y gemelo, en la misma mirada',
    'concept.text': 'En vez de mirar la telemetría en un panel, miras la plataforma. El móvil entiende lo que tiene delante y te lo devuelve anotado, con la réplica digital encajada encima.',
    'concept.vision.title': 'Visión por computador',
    'concept.vision.text': 'Un modelo YOLO detecta la estructura, sus partes y las personas u objetos del entorno, devolviendo cajas y keypoints.',
    'concept.twin.title': 'Gemelo digital',
    'concept.twin.text': 'El modelo 3D de la plataforma OC4 se renderiza con three.js sobre el mismo encuadre de la cámara.',
    'concept.domain.title': 'Un solo dominio',
    'concept.domain.text': 'Un control de mezcla recorre de lo real a lo digital sin cambiar de vista: lo que ves es lo mismo, en dos capas.',

    'pipeline.badge': 'Cómo funciona',
    'pipeline.title': 'Cuatro pasos, todos locales',
    'pipeline.text': 'El bucle se auto-limita para no calentar el teléfono: nunca lanza una inferencia mientras la anterior sigue en marcha, y respeta el límite de FPS que elijas.',
    'pipeline.chip.webgpu': 'WebGPU / WASM',
    'pipeline.chip.threads': 'Multi-hilo si el navegador lo permite',
    'pipeline.step1.label': '1 · Captura',
    'pipeline.step1.text': 'getUserMedia abre la cámara trasera a 720p/30fps.',
    'pipeline.step2.label': '2 · Inferencia',
    'pipeline.step2.text': 'onnxruntime-web ejecuta el modelo con WebGPU o WASM.',
    'pipeline.step3.label': '3 · Overlay',
    'pipeline.step3.text': 'Las cajas se proyectan sobre el vídeo, corregidas por el recorte de encuadre.',
    'pipeline.step4.label': '4 · Gemelo',
    'pipeline.step4.text': 'Los hologramas se anclan en la escena 3D y siguen al objetivo al girar el móvil.',

    'model.badge': 'Paso 1',
    'model.title': 'Carga el modelo ONNX',
    'model.text.before': 'Sirve cualquier export de YOLOv8/v11 —detección o pose— y la app deduce sola el tamaño de entrada, el número de clases y si hay keypoints. Si tu modelo es propio, añade un ',
    'model.text.after': ' con un nombre de clase por línea.',
    'model.note': 'Es opcional: puedes entrar sin modelo y ver la cámara con el gemelo.',

    'camera.badge': 'Paso 2',
    'camera.title': 'Activa la cámara',
    'camera.text.before': 'Necesitas HTTPS (o ',
    'camera.text.after': ') para que el navegador conceda acceso. El vídeo nunca sale del dispositivo.',

    'ready.badge': 'Último paso',
    'ready.title': 'Gira el móvil: funciona en las dos posturas',
    'ready.text': 'En vertical el escenario queda arriba y los ajustes en una hoja inferior. En horizontal se convierte en cabina: escenario a pantalla completa, mezcla a la izquierda y ajustes a la derecha.',
    'ready.list1': '· La mezcla real ↔ gemelo se controla con el deslizador central.',
    'ready.list2': '· «Recentrar» vuelve a orientar el gemelo hacia ti cuando el giroscopio derive.',
    'ready.list3': '· Todo se apaga y se limpia al salir: la cámara se libera al instante.',
    'ready.enter': 'Entrar en directo',
    'ready.hint': 'La cámara aún no está activa: en el paso anterior puedes conceder el permiso.',

    'a11y.section': 'Ir a la sección',
    'a11y.deck': 'Recorrido de presentación, una tarjeta por pantalla',
} as const;

export type Dict = Record<keyof typeof es, string>;
