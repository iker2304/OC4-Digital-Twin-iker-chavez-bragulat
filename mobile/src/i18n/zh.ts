/** 简体中文词典。键名必须与 `es.ts` 完全一致（`Dict` 会在编译期检查）。 */
import type { Dict } from './es';

export const zh: Dict = {
    'lang.name': '简体中文',
    'lang.switch': '语言',

    'nav.skip': '跳过',
    'nav.brand': 'Digital Twin · Mobile',

    'hero.kicker': 'OC4',
    'hero.title': 'Live Digital Twin',
    'hero.text.before': '用手机对准漂浮式风电平台，数字孪生就会叠加显示，检测完全',
    'hero.text.strong': '在设备本地运行',
    'hero.text.after': '：无需服务器，视频不会上传到任何地方。',
    'hero.imageAlt': '叠加了检测结果的视频帧：平台与叶轮的关键点和边界框。',
    'hero.scroll': '滑动',

    'concept.badge': '设计思路',
    'concept.title': '现实与孪生，一眼同框',
    'concept.text': '不必盯着仪表盘看遥测数据，直接看向平台本身。手机会理解眼前的东西，并把标注结果回传给你，数字副本精确叠在上面。',
    'concept.vision.title': '计算机视觉',
    'concept.vision.text': 'YOLO 模型检测结构本体、各个部件以及周围的人或物体，输出边界框和关键点。',
    'concept.twin.title': '数字孪生',
    'concept.twin.text': 'OC4 平台的三维模型用 three.js 渲染在与相机完全相同的取景框上。',
    'concept.domain.title': '同一场景',
    'concept.domain.text': '一个混合滑块就能从现实滑到数字，不用切换视图：你看到的是同一个东西的两个图层。',

    'pipeline.badge': '工作方式',
    'pipeline.title': '四个步骤，全部本地完成',
    'pipeline.text': '推理循环会自我限速，避免手机发热：上一次推理没结束时绝不发起新的推理，并遵守你设定的帧率上限。',
    'pipeline.chip.webgpu': 'WebGPU / WASM',
    'pipeline.chip.threads': '浏览器支持时启用多线程',
    'pipeline.step1.label': '1 · 采集',
    'pipeline.step1.text': 'getUserMedia 以 720p/30fps 打后置摄像头。',
    'pipeline.step2.label': '2 · 推理',
    'pipeline.step2.text': 'onnxruntime-web 通过 WebGPU 或 WASM 运行模型。',
    'pipeline.step3.label': '3 · 叠加',
    'pipeline.step3.text': '边界框投影到视频上，并按取景裁剪做校正。',
    'pipeline.step4.label': '4 · 孪生',
    'pipeline.step4.text': '全息影像锚定在三维场景中，转动手机时会跟随目标。',

    'model.badge': '第 1 步',
    'model.title': '加载 ONNX 模型',
    'model.text.before': '任何 YOLOv8/v11 导出都可以——检测或姿态——应用会自动推断输入尺寸、类别数量以及是否有关键点。如果是你自己的模型，再添加一个 ',
    'model.text.after': '，每行一个类别名。',
    'model.note': '此步可选：不加载模型也能进入，只看相机和孪生。',

    'camera.badge': '第 2 步',
    'camera.title': '启用摄像头',
    'camera.text.before': '需要 HTTPS（或 ',
    'camera.text.after': '）浏览器才会授予权限。视频永远不会离开设备。',

    'ready.badge': '最后一步',
    'ready.title': '转动手机：横竖屏都能用',
    'ready.text': '竖屏时场景在上方、设置在下方的抽屉里。横屏时变成驾驶舱：场景全屏、混合滑块在左、设置在右。',
    'ready.list1': '· 现实 ↔ 孪生的混合由中央滑块控制。',
    'ready.list2': '· 陀螺仪漂移时，「重新居中」会把孪生对准你。',
    'ready.list3': '· 退出时全部关闭并清理：摄像头立刻释放。',
    'ready.enter': '进入实时画面',
    'ready.hint': '摄像头尚未启用：你可以在上一步授予权限。',

    'a11y.section': '前往第',
    'a11y.deck': '介绍卡片，每屏一张',
};
