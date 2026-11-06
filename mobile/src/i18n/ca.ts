/** Diccionari en català. Les claus han de coincidir amb `es.ts` (`Dict` ho comprova). */
import type { Dict } from './es';

export const ca: Dict = {
    'lang.name': 'Català',
    'lang.switch': 'Idioma',

    'nav.skip': 'Salta',
    'nav.brand': 'Digital Twin · Mobile',

    'hero.kicker': 'OC4',
    'hero.title': 'Live Digital Twin',
    'hero.text.before': 'Apunta amb la càmera del mòbil a la plataforma eòlica flotant i veuràs el bessó digital superposat, amb la detecció corrent ',
    'hero.text.strong': 'al propi dispositiu',
    'hero.text.after': ': sense servidors, sense pujar vídeo enlloc.',
    'hero.imageAlt': 'Fotograma del vídeo amb la detecció superposada: caixa i keypoints de la plataforma i del rotor.',
    'hero.scroll': 'Llisca',

    'concept.badge': 'La idea',
    'concept.title': 'Realitat i bessó, en una sola mirada',
    'concept.text': "En lloc de mirar la telemetria en un panell, mires la plataforma. El mòbil entén el que té al davant i t'ho retorna anotat, amb la rèplica digital encaixada a sobre.",
    'concept.vision.title': 'Visió per computador',
    'concept.vision.text': "Un model YOLO detecta l'estructura, les seves parts i les persones o objectes de l'entorn, retornant caixes i keypoints.",
    'concept.twin.title': 'Bessó digital',
    'concept.twin.text': 'El model 3D de la plataforma OC4 es renderitza amb three.js sobre el mateix enquadrament de la càmera.',
    'concept.domain.title': 'Un sol domini',
    'concept.domain.text': 'Un control de mescla recorre del real al digital sense canviar de vista: el que veus és el mateix, en dues capes.',

    'pipeline.badge': 'Com funciona',
    'pipeline.title': 'Quatre passos, tots locals',
    'pipeline.text': "El bucle s'autolimita per no escalfar el telèfon: mai llança una inferència mentre l'anterior segueix en marxa, i respecta el límit de FPS que triïs.",
    'pipeline.chip.webgpu': 'WebGPU / WASM',
    'pipeline.chip.threads': 'Multifil si el navegador ho permet',
    'pipeline.step1.label': '1 · Captura',
    'pipeline.step1.text': 'getUserMedia obre la càmera posterior a 720p/30fps.',
    'pipeline.step2.label': '2 · Inferència',
    'pipeline.step2.text': 'onnxruntime-web executa el model amb WebGPU o WASM.',
    'pipeline.step3.label': '3 · Overlay',
    'pipeline.step3.text': "Les caixes es projecten sobre el vídeo, corregides pel retall d'enquadrament.",
    'pipeline.step4.label': '4 · Bessó',
    'pipeline.step4.text': 'Els hologrames s’ancoren a l’escena 3D i segueixen l’objectiu en girar el mòbil.',

    'model.badge': 'Pas 1',
    'model.title': 'Carrega el model ONNX',
    'model.text.before': "Serveix qualsevol export de YOLOv8/v11 —detecció o pose— i l'app dedueix sola la mida d'entrada, el nombre de classes i si hi ha keypoints. Si el model és teu, afegeix un ",
    'model.text.after': " amb un nom de classe per línia.",
    'model.note': 'És opcional: pots entrar sense model i veure la càmera amb el bessó.',

    'camera.badge': 'Pas 2',
    'camera.title': 'Activa la càmera',
    'camera.text.before': 'Necessites HTTPS (o ',
    'camera.text.after': ') perquè el navegador concedeixi accés. El vídeo no surt mai del dispositiu.',

    'ready.badge': 'Últim pas',
    'ready.title': 'Gira el mòbil: funciona en les dues postures',
    'ready.text': "En vertical l'escena queda a dalt i els ajustos en un full inferior. En horitzontal es converteix en cabina: escena a pantalla completa, mescla a l'esquerra i ajustos a la dreta.",
    'ready.list1': '· La mescla real ↔ bessó es controla amb el lliscador central.',
    'ready.list2': '· «Recentra» torna a orientar el bessó cap a tu quan el giroscopi deriva.',
    'ready.list3': "· Tot s'apaga i es neteja en sortir: la càmera s'allibera a l'instant.",
    'ready.enter': 'Entra en directe',
    'ready.hint': 'La càmera encara no està activa: al pas anterior pots concedir el permís.',

    'a11y.section': 'Ves a la secció',
    'a11y.deck': 'Recorregut de presentació, una targeta per pantalla',
};
