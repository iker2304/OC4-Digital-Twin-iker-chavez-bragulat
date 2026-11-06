/**
 * Three languages, one flat dictionary.
 *
 * The public wizard is opened by whoever scans a QR code, so it cannot assume
 * Spanish. A full i18n library would be a dependency, a provider and a build step
 * for ~60 strings; a typed lookup costs nothing and keeps the bundle small — which
 * matters here because the page downloads ONNX models over mobile data.
 *
 * Catalan is included because the study is at UPC: the people most likely to be
 * handed the QR code are local.
 */
export type Locale = 'es' | 'en' | 'ca';

export const LOCALES: Array<{ id: Locale; label: string }> = [
    { id: 'es', label: 'Español' },
    { id: 'en', label: 'English' },
    { id: 'ca', label: 'Català' },
];

type Dict = Record<string, string>;

const ES: Dict = {
    'public.title': 'Banco de pruebas de dispositivos',
    'public.subtitle':
        'Mide lo que puede tu dispositivo con el gemelo digital: primero se calibra, después ejecuta la batería de tests con cada modelo.',
    'public.language': 'Idioma',
    'public.step': 'Paso {n} de 2',
    'public.step1.title': '1 · Calibrar el dispositivo',
    'public.step1.hint':
        'Estos datos identifican la medida. El nombre y los apellidos se guardan en el servidor del estudio; el apodo es lo que se verá en las gráficas.',
    'public.field.fullName': 'Nombre y apellidos',
    'public.field.fullName.placeholder': 'Ada Lovelace',
    'public.field.nick': 'Apodo del dispositivo',
    'public.field.nick.placeholder': 'Portátil de Ada',
    'public.field.description': 'Descripción breve del dispositivo',
    'public.field.description.placeholder': 'Portátil 2021, 16 GB, sin GPU dedicada',
    'public.field.category': 'Categoría',
    'public.category.sobremesa': 'Sobremesa',
    'public.category.portatil': 'Portátil',
    'public.category.movil': 'Móvil',
    'public.action.calibrate': 'Calibrar dispositivo',
    'public.action.next': 'Continuar a los tests',
    'public.action.calibrating': 'Calibrando…',
    'public.action.start': 'Ejecutar todos los tests',
    'public.action.stop': 'Parar',
    'public.action.restart': 'Empezar de nuevo',
    'public.required': 'Obligatorio',
    'public.calib.cpuSingle': 'CPU 1 núcleo',
    'public.calib.cpuMulti': 'CPU todos los núcleos',
    'public.calib.scaling': 'Escalado',
    'public.calib.cores': 'Núcleos lógicos',
    'public.calib.memory': 'RAM detectada',
    'public.calib.buffer': 'Memoria sostenible',
    'public.calib.gpu': 'GPU',
    'public.calib.gpuDraw': 'Relleno de GPU',
    'public.calib.webgpu': 'WebGPU',
    'public.calib.score': 'Puntuación',
    'public.calib.tier': 'Gama estimada',
    'public.calib.tier.alta': 'alta',
    'public.calib.tier.media': 'media',
    'public.calib.tier.baja': 'baja',
    'public.calib.no': 'no',
    'public.calib.yes': 'sí',
    'public.calib.hidden': 'no revelada por el navegador',
    'public.stage.single': 'Midiendo CPU (1 núcleo)',
    'public.stage.sustained': 'Comprobando si se calienta',
    'public.stage.scaling': 'Midiendo escalado entre núcleos',
    'public.stage.memory': 'Midiendo memoria',
    'public.stage.gpu': 'Midiendo GPU',
    'public.stage.platform': 'Leyendo plataforma',
    'public.stage.done': 'Listo',
    'public.calib.sustained': 'CPU sostenido',
    'public.calib.throttle': 'Pérdida por calor',
    'public.calib.spread': 'Dispersión entre pasadas',
    'public.calib.efficiency': 'Eficiencia por núcleo',
    'public.calib.heap': 'Límite del heap JS',
    'public.calib.wasm': 'WebAssembly',
    'public.calib.timer': 'Resolución del reloj',
    'public.calib.duration': 'Duración de la calibración',
    'public.calib.takes': 'Tarda unos 25 s. No cierres la pestaña: se está midiendo de verdad.',
    'public.calib.threads': 'hilos',
    'public.calib.unreliable': 'pestaña en segundo plano: medida no fiable',
    'public.calib.degrades': 'degrada',
    'public.calib.notExposed': 'no lo expone este navegador',
    'public.calib.ceiling': 'tope del test',
            'public.step2.title': '2 · Batería de tests por modelo',
    'public.step2.hint':
        'Se cargan todos los modelos desplegados, uno detrás de otro, y por cada uno se ejecutan los siete tests. No cierres la pestaña ni bloquees el móvil; si se apaga la pantalla, el navegador pausa la medición.',
    'public.step2.models': '{n} modelos',
    'public.step2.loading': 'Cargando modelo {index}/{total}: {name}',
    'public.step2.testing': 'Modelo {index}/{total} · test {test} ({done}/{tests})',
    'public.step2.saving': 'Guardando resultados…',
    'public.step2.done': 'Terminado: {runs} ejecuciones guardadas en {models} modelos.',
    'public.step2.stopped': 'Detenido. Se han guardado {runs} ejecuciones.',
    'public.step2.error': 'No se pudo cargar «{name}»: {error}',
    'public.step2.empty': 'El servidor no ofrece ningún modelo.',
    'public.step2.wakelock': 'Pantalla mantenida encendida',
    'public.step2.nowakelock': 'Este navegador no permite mantener la pantalla encendida',
    'public.step2.keep': 'No bloquees el móvil durante la prueba.',
    'public.results.title': 'Resultados de este dispositivo',
    'public.results.hint': 'Ya están en el servidor; puedes cerrar esta página.',
};

const EN: Dict = {
    'public.title': 'Device benchmark',
    'public.subtitle':
        'Measure what your device can do with the digital twin: first it calibrates itself, then it runs the test suite against every model.',
    'public.language': 'Language',
    'public.step': 'Step {n} of 2',
    'public.step1.title': '1 · Calibrate the device',
    'public.step1.hint':
        'These fields identify the measurement. The full name is stored on the study server; the nickname is what appears in the charts.',
    'public.field.fullName': 'Full name',
    'public.field.fullName.placeholder': 'Ada Lovelace',
    'public.field.nick': 'Device nickname',
    'public.field.nick.placeholder': "Ada's laptop",
    'public.field.description': 'Short device description',
    'public.field.description.placeholder': '2021 laptop, 16 GB, no dedicated GPU',
    'public.field.category': 'Category',
    'public.category.sobremesa': 'Desktop',
    'public.category.portatil': 'Laptop',
    'public.category.movil': 'Phone',
    'public.action.calibrate': 'Calibrate device',
    'public.action.next': 'Continue to the tests',
    'public.action.calibrating': 'Calibrating…',
    'public.action.start': 'Run every test',
    'public.action.stop': 'Stop',
    'public.action.restart': 'Start over',
    'public.required': 'Required',
    'public.calib.cpuSingle': 'Single-core CPU',
    'public.calib.cpuMulti': 'All-core CPU',
    'public.calib.scaling': 'Scaling',
    'public.calib.cores': 'Logical cores',
    'public.calib.memory': 'Reported RAM',
    'public.calib.buffer': 'Sustainable memory',
    'public.calib.gpu': 'GPU',
    'public.calib.gpuDraw': 'GPU fill rate',
    'public.calib.webgpu': 'WebGPU',
    'public.calib.score': 'Score',
    'public.calib.tier': 'Estimated tier',
    'public.calib.tier.alta': 'high',
    'public.calib.tier.media': 'mid',
    'public.calib.tier.baja': 'low',
    'public.calib.no': 'no',
    'public.calib.yes': 'yes',
    'public.calib.hidden': 'not disclosed by the browser',
    'public.calib.sustained': 'Sustained CPU',
    'public.calib.throttle': 'Thermal loss',
    'public.calib.spread': 'Run-to-run spread',
    'public.calib.efficiency': 'Per-core efficiency',
    'public.calib.heap': 'JS heap limit',
    'public.calib.wasm': 'WebAssembly',
    'public.calib.timer': 'Clock resolution',
    'public.calib.duration': 'Calibration duration',
    'public.calib.takes': 'It takes about 25 s. Do not close the tab: it is really measuring.',
    'public.calib.threads': 'threads',
    'public.calib.unreliable': 'background tab: unreliable measurement',
    'public.calib.degrades': 'degrades',
    'public.calib.notExposed': 'not exposed by this browser',
    'public.calib.ceiling': 'test ceiling',
    'public.stage.single': 'Measuring CPU (1 core)',
    'public.stage.sustained': 'Checking thermal throttling',
    'public.stage.scaling': 'Measuring core scaling',
    'public.stage.memory': 'Measuring memory',
    'public.stage.gpu': 'Measuring GPU',
    'public.stage.platform': 'Reading platform',
    'public.stage.done': 'Ready',
    'public.step2.title': '2 · Test suite per model',
    'public.step2.hint':
        'Every deployed model is loaded in turn and the seven tests are run against each one. Do not close the tab or lock the phone: when the screen sleeps the browser pauses the measurement.',
    'public.step2.models': '{n} models',
    'public.step2.loading': 'Loading model {index}/{total}: {name}',
    'public.step2.testing': 'Model {index}/{total} · test {test} ({done}/{tests})',
    'public.step2.saving': 'Saving results…',
    'public.step2.done': 'Done: {runs} runs saved across {models} models.',
    'public.step2.stopped': 'Stopped. {runs} runs saved.',
    'public.step2.error': 'Could not load “{name}”: {error}',
    'public.step2.empty': 'The server serves no models.',
    'public.step2.wakelock': 'Screen kept awake',
    'public.step2.nowakelock': 'This browser cannot keep the screen awake',
    'public.step2.keep': 'Do not lock the phone during the test.',
    'public.results.title': 'Results from this device',
    'public.results.hint': 'They are already on the server; you can close this page.',
};

const CA: Dict = {
    'public.title': 'Banc de proves de dispositius',
    'public.subtitle':
        "Mesura què pot fer el teu dispositiu amb el bessó digital: primer es calibra i després executa la bateria de tests amb cada model.",
    'public.language': 'Idioma',
    'public.step': 'Pas {n} de 2',
    'public.step1.title': '1 · Calibrar el dispositiu',
    'public.step1.hint':
        'Aquestes dades identifiquen la mesura. El nom i els cognoms es guarden al servidor de l’estudi; l’àlies és el que es veurà a les gràfiques.',
    'public.field.fullName': 'Nom i cognoms',
    'public.field.fullName.placeholder': 'Ada Lovelace',
    'public.field.nick': 'Àlies del dispositiu',
    'public.field.nick.placeholder': "Portàtil de l'Ada",
    'public.field.description': 'Descripció breu del dispositiu',
    'public.field.description.placeholder': 'Portàtil 2021, 16 GB, sense GPU dedicada',
    'public.field.category': 'Categoria',
    'public.category.sobremesa': 'Sobretaula',
    'public.category.portatil': 'Portàtil',
    'public.category.movil': 'Mòbil',
    'public.action.calibrate': 'Calibrar dispositiu',
    'public.action.next': 'Continuar als tests',
    'public.action.calibrating': 'Calibrant…',
    'public.action.start': 'Executar tots els tests',
    'public.action.stop': 'Aturar',
    'public.action.restart': 'Començar de nou',
    'public.required': 'Obligatori',
    'public.calib.cpuSingle': 'CPU 1 nucli',
    'public.calib.cpuMulti': 'CPU tots els nuclis',
    'public.calib.scaling': 'Escalat',
    'public.calib.cores': 'Nuclis lògics',
    'public.calib.memory': 'RAM detectada',
    'public.calib.buffer': 'Memòria sostenible',
    'public.calib.gpu': 'GPU',
    'public.calib.gpuDraw': 'Emplenament de GPU',
    'public.calib.webgpu': 'WebGPU',
    'public.calib.score': 'Puntuació',
    'public.calib.tier': 'Gamma estimada',
    'public.calib.tier.alta': 'alta',
    'public.calib.tier.media': 'mitjana',
    'public.calib.tier.baja': 'baixa',
    'public.calib.no': 'no',
    'public.calib.yes': 'sí',
    'public.calib.hidden': 'no revelada pel navegador',
    'public.calib.sustained': 'CPU sostingut',
    'public.calib.throttle': 'Pèrdua per calor',
    'public.calib.spread': 'Dispersió entre passades',
    'public.calib.efficiency': 'Eficiència per nucli',
    'public.calib.heap': 'Límit del heap JS',
    'public.calib.wasm': 'WebAssembly',
    'public.calib.timer': 'Resolució del rellotge',
    'public.calib.duration': 'Durada de la calibració',
    'public.calib.takes': 'Trigà uns 25 s. No tanquis la pestanya: s’està mesurant de debò.',
    'public.calib.threads': 'fils',
    'public.calib.unreliable': 'pestanya en segon pla: mesura no fiable',
    'public.calib.degrades': 'degrada',
    'public.calib.notExposed': 'no ho exposa aquest navegador',
    'public.calib.ceiling': 'sostre del test',
    'public.stage.single': 'Mesurant CPU (1 nucli)',
    'public.stage.sustained': 'Comprovant si s’escalfa',
    'public.stage.scaling': 'Mesurant escalat entre nuclis',
    'public.stage.memory': 'Mesurant memòria',
    'public.stage.gpu': 'Mesurant GPU',
    'public.stage.platform': 'Llegint plataforma',
    'public.stage.done': 'A punt',
    'public.step2.title': '2 · Bateria de tests per model',
    'public.step2.hint':
        'Es carreguen tots els models desplegats, un darrere l’altre, i per a cadascun s’executen els set tests. No tanquis la pestanya ni bloquegis el mòbil: si la pantalla s’apaga, el navegador atura la mesura.',
    'public.step2.models': '{n} models',
    'public.step2.loading': 'Carregant model {index}/{total}: {name}',
    'public.step2.testing': 'Model {index}/{total} · test {test} ({done}/{tests})',
    'public.step2.saving': 'Guardant resultats…',
    'public.step2.done': 'Acabat: {runs} execucions guardades en {models} models.',
    'public.step2.stopped': 'Aturat. S’han guardat {runs} execucions.',
    'public.step2.error': 'No s’ha pogut carregar «{name}»: {error}',
    'public.step2.empty': 'El servidor no ofereix cap model.',
    'public.step2.wakelock': 'Pantalla mantinguda encesa',
    'public.step2.nowakelock': 'Aquest navegador no permet mantenir la pantalla encesa',
    'public.step2.keep': 'No bloquegis el mòbil durant la prova.',
    'public.results.title': 'Resultats d’aquest dispositiu',
    'public.results.hint': 'Ja són al servidor; pots tancar aquesta pàgina.',
};

const DICT: Record<Locale, Dict> = { es: ES, en: EN, ca: CA };

const STORAGE_KEY = 'oc4.public-locale';

/** Browser language → one of ours, defaulting to Spanish. */
export function detectLocale(): Locale {
    try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        if (saved === 'es' || saved === 'en' || saved === 'ca') return saved;
    } catch {
        // Private mode.
    }
    const languages = [navigator.language, ...(navigator.languages ?? [])].filter(Boolean);
    for (const language of languages) {
        const short = language.toLowerCase().slice(0, 2);
        if (short === 'ca') return 'ca';
        if (short === 'en') return 'en';
        if (short === 'es') return 'es';
    }
    return 'es';
}

export function rememberLocale(locale: Locale): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
        // Private mode: the choice just does not survive the reload.
    }
}

/** Look up a key, substituting `{name}` placeholders. Falls back to Spanish. */
export function translate(
    locale: Locale,
    key: string,
    vars?: Record<string, string | number>
): string {
    const template = DICT[locale]?.[key] ?? ES[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match
    );
}
