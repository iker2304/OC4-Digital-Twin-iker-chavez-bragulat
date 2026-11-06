/** English dictionary. Keys must match `es.ts` exactly (`Dict` enforces it). */
import type { Dict } from './es';

export const en: Dict = {
    'lang.name': 'English',
    'lang.switch': 'Language',

    'nav.skip': 'Skip',
    'nav.brand': 'Digital Twin · Mobile',

    'hero.kicker': 'OC4',
    'hero.title': 'Live Digital Twin',
    'hero.text.before': 'Point your phone at the floating wind platform and the digital twin appears on top, with detection running ',
    'hero.text.strong': 'on the device itself',
    'hero.text.after': ': no servers, no video uploaded anywhere.',
    'hero.imageAlt': 'Video still with the detection overlaid: platform and rotor boxes and keypoints.',
    'hero.scroll': 'Swipe',

    'concept.badge': 'The idea',
    'concept.title': 'Reality and twin, in one glance',
    'concept.text': 'Instead of reading telemetry on a dashboard, you look at the platform. The phone understands what is in front of it and hands it back annotated, with the digital replica fitted on top.',
    'concept.vision.title': 'Computer vision',
    'concept.vision.text': 'A YOLO model detects the structure, its parts and the people or objects around it, returning boxes and keypoints.',
    'concept.twin.title': 'Digital twin',
    'concept.twin.text': 'The 3D model of the OC4 platform is rendered with three.js over the same camera framing.',
    'concept.domain.title': 'One single domain',
    'concept.domain.text': 'A blend control sweeps from real to digital without changing views: what you see is the same thing, in two layers.',

    'pipeline.badge': 'How it works',
    'pipeline.title': 'Four steps, all local',
    'pipeline.text': 'The loop throttles itself so the phone does not heat up: it never starts an inference while the previous one is still running, and it honours the FPS cap you choose.',
    'pipeline.chip.webgpu': 'WebGPU / WASM',
    'pipeline.chip.threads': 'Multi-threaded when the browser allows it',
    'pipeline.step1.label': '1 · Capture',
    'pipeline.step1.text': 'getUserMedia opens the rear camera at 720p/30fps.',
    'pipeline.step2.label': '2 · Inference',
    'pipeline.step2.text': 'onnxruntime-web runs the model on WebGPU or WASM.',
    'pipeline.step3.label': '3 · Overlay',
    'pipeline.step3.text': 'Boxes are projected onto the video, corrected for the framing crop.',
    'pipeline.step4.label': '4 · Twin',
    'pipeline.step4.text': 'Holograms are anchored in the 3D scene and follow the target as you turn the phone.',

    'model.badge': 'Step 1',
    'model.title': 'Load the ONNX model',
    'model.text.before': 'Any YOLOv8/v11 export works —detection or pose— and the app works out the input size, the number of classes and whether there are keypoints. If the model is yours, add a ',
    'model.text.after': ' with one class name per line.',
    'model.note': 'Optional: you can go in without a model and see the camera with the twin.',

    'camera.badge': 'Step 2',
    'camera.title': 'Enable the camera',
    'camera.text.before': 'HTTPS (or ',
    'camera.text.after': ') is required for the browser to grant access. The video never leaves the device.',

    'ready.badge': 'Last step',
    'ready.title': 'Turn the phone: both orientations work',
    'ready.text': 'In portrait the scene sits on top and the settings in a bottom sheet. In landscape it becomes a cockpit: full-screen scene, blend on the left and settings on the right.',
    'ready.list1': '· The real ↔ twin blend is driven by the centre slider.',
    'ready.list2': '· “Recentre” points the twin back at you when the gyroscope drifts.',
    'ready.list3': '· Everything is shut down and cleaned up on exit: the camera is released immediately.',
    'ready.enter': 'Go live',
    'ready.hint': 'The camera is not active yet: you can grant permission in the previous step.',

    'a11y.section': 'Go to section',
    'a11y.deck': 'Presentation deck, one card per screen',
};
