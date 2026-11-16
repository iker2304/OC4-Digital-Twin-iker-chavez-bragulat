import { useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Cpu, GitBranch, Layers, Activity, ShieldAlert, ArrowRight, Network } from 'lucide-react';

interface ArchBlockDetail {
  id: string;
  title: string;
  subtitle: string;
  category: 'input' | 'gnn' | 'pinn' | 'loss' | 'output';
  tensorIn: string;
  tensorOut: string;
  moduleRef: string;
  description: string;
  formula: string;
}

const ARCH_DETAILS: Record<string, ArchBlockDetail> = {
  inputs: {
    id: 'inputs',
    title: '1. Pose 6-DOF + Ambiente',
    subtitle: 'Cámara PnP / MQTT oc4/pose',
    category: 'input',
    tensorIn: 'pose_6dof (6), vel_6dof (6), env_4 (4)',
    tensorOut: 'global_cond (B, 16) + r_fair (B, 3, 3)',
    moduleRef: 'physics_catenary.py → PlatformToFairleadKinematics',
    description:
      'Convierte la traslación (Surge, Sway, Heave) y rotación Euler ZYX (Roll, Pitch, Yaw) capturadas por visión artificial (escala 1:100 escalada por Froude λ=100) a la posición y velocidad 3D exacta de los 3 fairleads a R=40.868m y z=-14m.',
    formula: 'r_fair,k = p_plat + R_zyx(φ, θ, ψ) · r_local,k ;  v_fair,k = v_plat + ω × (R_zyx · r_local,k)',
  },
  catenary: {
    id: 'catenary',
    title: '2. Prior Catenaria Elástica',
    subtitle: 'ElasticCatenarySolver (NREL OC4)',
    category: 'input',
    tensorIn: 'r_anchor (3, 3), r_fairlead (3, 3)',
    tensorOut: 'pos_cat_nom (B, 3, 21, 3)',
    moduleRef: 'physics_catenary.py → ElasticCatenarySolver',
    description:
      'Resuelve la catenaria elástica cuasi-estática C1-continua (con tramo apoyado en el lecho marino L_B ≥ 0 o totalmente suspendida). Sirve como punto de partida físico exacto para que la GNN aprenda las correcciones dinámicas e hidrodinámicas.',
    formula: 'X_F = L_B + (H/w) asinh(V/H) + H·L0/EA ;  Z_F = (H/w)(√(1+(V/H)²) - 1) + V²/(2wEA)',
  },
  graph: {
    id: 'graph',
    title: '3. Constructor de Grafo G = (V, E)',
    subtitle: '64 Nodos · 126 Aristas dirigidas',
    category: 'gnn',
    tensorIn: 'pos_cat_nom, pos_eq, vel_prior, env_4',
    tensorOut: 'X_V (B, 64, 16), E_attr (B, 126, 10)',
    moduleRef: 'graph_builder.py → MooringGraphBuilder',
    description:
      'Discretiza cada línea en 20 segmentos (21 nodos × 3 = 63 nodos de línea) + 1 super-nodo central de plataforma. Incluye 120 aristas intra-línea bidireccionales y 6 aristas de acoplamiento plataforma–fairlead para detectar asimetrías inter-línea.',
    formula: 'V = {v_{k,j}}_{k=1..3, j=0..20} ∪ {v_plat} ;  |V| = 64, |E| = 126',
  },
  encoders: {
    id: 'encoders',
    title: '4. Encoders (Node / Edge / Global)',
    subtitle: 'Proyección al espacio latente d = 128',
    category: 'gnn',
    tensorIn: 'X_V (16), E_attr (10), g (16)',
    tensorOut: 'h_V^(0) (B, 64, 128), h_E^(0) (B, 126, 128), g_ctx (B, 128)',
    moduleRef: 'models.py → MooringPIGNN.node_encoder / edge_encoder',
    description:
      'Tres MLPs de 2 capas con activación SiLU (suave C∞ para gradientes físicos) y LayerNorm que proyectan los atributos geométricos, de deformación y de contorno a un espacio latente homogéneo de 128 dimensiones.',
    formula: 'h_V^(0) = LayerNorm(MLP_node(X_V)),   h_E^(0) = LayerNorm(MLP_edge(E_attr))',
  },
  mp_layers: {
    id: 'mp_layers',
    title: '5. Processor: 6 × PhysicsMessagePassing',
    subtitle: 'Propagación de fuerzas y equilibrio nodal',
    category: 'gnn',
    tensorIn: 'h_V^(l), h_E^(l), edge_index (2, 126)',
    tensorOut: 'h_V^(6) (B, 64, 128), h_E^(6) (B, 126, 128)',
    moduleRef: 'models.py → PhysicsMessagePassingLayer',
    description:
      'Cada capa actualiza primero los mensajes en aristas (esfuerzos internos entre nodos vecinos condicionados por g_ctx), los agrega por suma (scatter_add_) imitando el equilibrio de fuerzas en cada nodo, y actualiza el estado nodal con conexión residual.',
    formula: 'e_ij^(l+1) = LN(e_ij^(l) + MLP_e([h_i, h_j, e_ij, g])) ;  h_j^(l+1) = LN(h_j^(l) + MLP_v([h_j, ∑_{i∈N(j)} e_ij, g]))',
  },
  head_kin: {
    id: 'head_kin',
    title: 'Output GNN 1: Cinemática 3D & TDZ',
    subtitle: 'node_kinematics_head (128 → 10)',
    category: 'output',
    tensorIn: 'h_line_nodes (B, 3, 21, 128)',
    tensorOut: 'pos_pred (B, 3, 21, 3), vel, acc, td_prob',
    moduleRef: 'models.py → MooringPIGNN.node_kinematics_head',
    description:
      'Predice el desplazamiento dinámico Δr respecto a la catenaria (con máscara Dirichlet exacta en ancla j=0 y fairlead j=20), velocidad v, aceleración a y probabilidad de contacto con el lecho marino (Touchdown Zone) en cada nodo.',
    formula: 'r_pred = pos_cat_nom + mask_BC · Δr_pred ;   p_td = σ(td_logit)',
  },
  head_ten: {
    id: 'head_ten',
    title: 'Output GNN 2: Tensión Axial Segmentos',
    subtitle: 'edge_tension_head (256 → 1)',
    category: 'output',
    tensorIn: '[e_sym, |e_fwd - e_bwd|] (B, 3, 20, 256)',
    tensorOut: 'tension_pred (B, 3, 20) [N] > 0',
    moduleRef: 'models.py → MooringPIGNN.edge_tension_head',
    description:
      'Combina simétricamente los embeddings de las aristas ida/vuelta de cada segmento y aplica Softplus escalado (1 MN) para garantizar tensiones estrictamente positivas a tracción desde el ancla hasta el fairlead.',
    formula: 'T_ij = Softplus(MLP_T([0.5(e_fwd+e_bwd), |e_fwd-e_bwd|])) · 10⁶ [N]',
  },
  head_shm: {
    id: 'head_shm',
    title: 'Output GNN 3: Diagnóstico SHM & Salud',
    subtitle: 'line_shm_head (512 → 5 clases + 2 ratios)',
    category: 'output',
    tensorIn: '[node_mean, node_max, edge_mean, h_plat] (B, 3, 512)',
    tensorOut: 'shm_probs (B, 3, 5), health_factors (B, 3, 2)',
    moduleRef: 'models.py → MooringPIGNN.line_shm_head',
    description:
      'Compara la respuesta agregada de cada línea frente al estado global de la plataforma para clasificar 5 estados (HEALTHY, PRETENSION_LOSS, STIFFNESS_DEGRADATION, BIOFOULING, LINE_BREAKAGE) y estimar los factores δ_EA = EA/EA_0 y δ_w = w/w_0.',
    formula: 'P(SHM_k) = Softmax(W_cls · h_shm,k) ;  [δ_EA, δ_w] = [1.5·σ(z0), 0.5 + 1.5·σ(z1)]',
  },
  cont_coords: {
    id: 'cont_coords',
    title: 'Rama PINN Continua: Fourier(s, t)',
    subtitle: 'ContinuousMooringPINN (Coordenadas)',
    category: 'pinn',
    tensorIn: 's_norm ∈ [0,1], t_norm, line_onehot (3), g (16)',
    tensorOut: 'st_fourier (M, 34) + contexto (M, 19)',
    moduleRef: 'models.py → FourierFeatureEncoding',
    description:
      'Codifica las coordenadas continuas adimensionales de longitud de arco s/L0 y tiempo t con 8 frecuencias armónicas de Fourier (senos y cosenos) para evitar sesgo espectral y capturar curvaturas finas cerca de la zona Touchdown.',
    formula: 'γ(s, t) = [s, t, sin(2^k π s), cos(2^k π s), sin(2^k π t), cos(2^k π t)]_{k=0..7}',
  },
  cont_ansatz: {
    id: 'cont_ansatz',
    title: 'Ansatz Dirichlet + Autograd PDE',
    subtitle: '4 × MLP SiLU (128) + torch.autograd.grad',
    category: 'pinn',
    tensorIn: 'feat (M, 53), r_anchor (M, 3), r_fairlead (M, 3)',
    tensorOut: 'r(s,t), T(s,t), r_s, r_ss, v, a, T_s',
    moduleRef: 'models.py → ContinuousMooringPINN.forward_with_derivatives',
    description:
      'Impone analíticamente las condiciones de contorno exactas en ancla (s=0) y fairlead (s=L0) mediante un término burbuja s(1-s), y diferencia exactamente respecto a (s, t) con torch.autograd.grad para evaluar la EDP continua.',
    formula: 'r(s,t) = (1-s̃)r_A + s̃·r_F(t) + s̃(1-s̃)·L0·MLP_r(z) ;  s̃ = s/L0 ∈ [0,1]',
  },
  pinn_loss: {
    id: 'pinn_loss',
    title: 'Fusión Física: MooringPINNLoss & ContinuousLoss',
    subtitle: '6 términos físicos + supervisión multi-tarea',
    category: 'loss',
    tensorIn: 'Predicciones GNN + Derivadas Autograd PINN',
    tensorOut: 'L_total (escalar diferenciable)',
    moduleRef: 'pinn_loss.py → MooringPINNLoss / ContinuousPINNLoss',
    description:
      'Penaliza cualquier violación de la física tanto en datos sintéticos como en trayectorias reales sin etiquetas: Hooke solo-tracción (L_const), equilibrio de momento 3D con Morison + masa añadida + reacción del fondo (L_momentum), contorno (L_bc), no penetración z ≥ -200m (L_seabed) y SHM.',
    formula: 'L = 10·L_pos + 5·L_ten + 2·L_const + 1·L_PDE + 10·L_bc + 5·L_bed + 1.5·L_shm + 2·L_health',
  },
};

const CATEGORY_STYLES: Record<ArchBlockDetail['category'], string> = {
  input: 'border-blue-500/70 bg-blue-950/80 text-blue-100',
  gnn: 'border-indigo-500/70 bg-indigo-950/85 text-indigo-100',
  pinn: 'border-cyan-500/70 bg-cyan-950/85 text-cyan-100',
  loss: 'border-amber-500/70 bg-amber-950/85 text-amber-100',
  output: 'border-emerald-500/70 bg-emerald-950/85 text-emerald-100',
};

function ArchNodeCard({ data, selected }: NodeProps) {
  const detail = data.detail as ArchBlockDetail;
  return (
    <div
      className={`w-[245px] rounded-xl border-2 px-3.5 py-2.5 shadow-lg transition-all cursor-pointer ${
        CATEGORY_STYLES[detail.category]
      } ${selected ? 'ring-2 ring-white scale-[1.02]' : 'hover:brightness-110'}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-300 !w-2.5 !h-2.5" />
      <div className="text-[10px] font-mono uppercase tracking-wider opacity-75">{detail.subtitle}</div>
      <div className="text-xs font-bold mt-0.5 leading-snug">{detail.title}</div>
      <div className="mt-1.5 inline-block px-2 py-0.5 rounded bg-black/35 text-[10px] font-mono text-slate-200 truncate max-w-full">
        {detail.tensorOut}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-slate-300 !w-2.5 !h-2.5" />
    </div>
  );
}

const nodeTypes = { archNode: ArchNodeCard };

function TopologySvg() {
  const cx = 190;
  const cy = 140;
  const angles = [180, 60, 300];
  const nodeSteps = [0.36, 0.56, 0.76, 0.96];

  return (
    <svg viewBox="0 0 380 280" className="w-full h-64 bg-slate-950 rounded-xl border border-slate-800">
      {/* Concentric reference rings */}
      <circle cx={cx} cy={cy} r={32} fill="none" stroke="#1e293b" strokeDasharray="3 3" />
      <circle cx={cx} cy={cy} r={118} fill="none" stroke="#1e293b" strokeDasharray="3 3" />

      {angles.map((deg, k) => {
        const rad = (deg * Math.PI) / 180;
        const fx = cx + 34 * Math.cos(rad);
        const fy = cy - 34 * Math.sin(rad);
        const ax = cx + 118 * Math.cos(rad);
        const ay = cy - 118 * Math.sin(rad);

        return (
          <g key={k}>
            {/* Platform <-> Fairlead coupling edge */}
            <line x1={cx} y1={cy} x2={fx} y2={fy} stroke="#f59e0b" strokeWidth={2.2} strokeDasharray="4 2" />
            {/* Intra-line mooring chain */}
            <line x1={fx} y1={fy} x2={ax} y2={ay} stroke="#6366f1" strokeWidth={2.5} />

            {/* Intermediate discretized line nodes */}
            {nodeSteps.map((t, j) => {
              const nx = cx + (34 + t * 84) * Math.cos(rad);
              const ny = cy - (34 + t * 84) * Math.sin(rad);
              const isAnchor = j === nodeSteps.length - 1;
              return (
                <circle
                  key={j}
                  cx={nx}
                  cy={ny}
                  r={isAnchor ? 6 : 4}
                  fill={isAnchor ? '#64748b' : '#38bdf8'}
                  stroke="#0f172a"
                  strokeWidth={1.5}
                />
              );
            })}

            {/* Fairlead node */}
            <circle cx={fx} cy={fy} r={6} fill="#10b981" stroke="#0f172a" strokeWidth={1.5} />
            <text
              x={cx + 132 * Math.cos(rad)}
              y={cy - 132 * Math.sin(rad) + 4}
              textAnchor="middle"
              fill="#cbd5e1"
              fontSize="10"
              fontFamily="monospace"
            >
              L{k + 1} ({deg}°)
            </text>
          </g>
        );
      })}

      {/* Platform Super-Node */}
      <circle cx={cx} cy={cy} r={12} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
      <text x={cx} y={cy + 3} textAnchor="middle" fill="#0f172a" fontSize="9" fontWeight="bold">
        P
      </text>

      {/* Legend inside SVG */}
      <g transform="translate(10, 242)">
        <circle cx={6} cy={6} r={4.5} fill="#f59e0b" />
        <text x={15} y={9} fill="#94a3b8" fontSize="9">Super-nodo Plataforma (v_p)</text>
        <circle cx={152} cy={6} r={4.5} fill="#10b981" />
        <text x={161} y={9} fill="#94a3b8" fontSize="9">Fairleads (3)</text>
        <circle cx={232} cy={6} r={4} fill="#38bdf8" />
        <text x={240} y={9} fill="#94a3b8" fontSize="9">Nodos Línea (57)</text>
        <circle cx={322} cy={6} r={4.5} fill="#64748b" />
        <text x={330} y={9} fill="#94a3b8" fontSize="9">Anclas (3)</text>
      </g>
    </svg>
  );
}

export default function MooringArchitectureDiagram({
  paramCount = 1312018,
  checkpointLoaded = false,
}: {
  paramCount?: number;
  checkpointLoaded?: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string>('mp_layers');

  const nodes: Node[] = useMemo(
    () => [
      { id: 'inputs', type: 'archNode', position: { x: 20, y: 150 }, data: { detail: ARCH_DETAILS.inputs } },
      { id: 'catenary', type: 'archNode', position: { x: 310, y: 50 }, data: { detail: ARCH_DETAILS.catenary } },
      { id: 'graph', type: 'archNode', position: { x: 600, y: 50 }, data: { detail: ARCH_DETAILS.graph } },
      { id: 'encoders', type: 'archNode', position: { x: 890, y: 50 }, data: { detail: ARCH_DETAILS.encoders } },
      { id: 'mp_layers', type: 'archNode', position: { x: 1180, y: 50 }, data: { detail: ARCH_DETAILS.mp_layers } },

      // GNN Output Heads
      { id: 'head_kin', type: 'archNode', position: { x: 1490, y: -40 }, data: { detail: ARCH_DETAILS.head_kin } },
      { id: 'head_ten', type: 'archNode', position: { x: 1490, y: 70 }, data: { detail: ARCH_DETAILS.head_ten } },
      { id: 'head_shm', type: 'archNode', position: { x: 1490, y: 180 }, data: { detail: ARCH_DETAILS.head_shm } },

      // Continuous PINN Branch
      { id: 'cont_coords', type: 'archNode', position: { x: 310, y: 270 }, data: { detail: ARCH_DETAILS.cont_coords } },
      { id: 'cont_ansatz', type: 'archNode', position: { x: 650, y: 270 }, data: { detail: ARCH_DETAILS.cont_ansatz } },

      // Physics Loss Fusion
      { id: 'pinn_loss', type: 'archNode', position: { x: 1180, y: 295 }, data: { detail: ARCH_DETAILS.pinn_loss } },
    ],
    []
  );

  const edges: Edge[] = useMemo(
    () => [
      { id: 'e-in-cat', source: 'inputs', target: 'catenary', animated: true, style: { stroke: '#60a5fa', strokeWidth: 2 } },
      { id: 'e-in-cont', source: 'inputs', target: 'cont_coords', animated: true, style: { stroke: '#22d3ee', strokeWidth: 2 } },
      { id: 'e-cat-gr', source: 'catenary', target: 'graph', animated: true, style: { stroke: '#818cf8', strokeWidth: 2 } },
      { id: 'e-gr-enc', source: 'graph', target: 'encoders', animated: true, style: { stroke: '#818cf8', strokeWidth: 2 } },
      { id: 'e-enc-mp', source: 'encoders', target: 'mp_layers', animated: true, style: { stroke: '#a78bfa', strokeWidth: 2.5 } },

      { id: 'e-mp-kin', source: 'mp_layers', target: 'head_kin', style: { stroke: '#34d399', strokeWidth: 2 } },
      { id: 'e-mp-ten', source: 'mp_layers', target: 'head_ten', style: { stroke: '#34d399', strokeWidth: 2 } },
      { id: 'e-mp-shm', source: 'mp_layers', target: 'head_shm', style: { stroke: '#34d399', strokeWidth: 2 } },

      { id: 'e-cc-ca', source: 'cont_coords', target: 'cont_ansatz', animated: true, style: { stroke: '#22d3ee', strokeWidth: 2 } },
      { id: 'e-ca-loss', source: 'cont_ansatz', target: 'pinn_loss', animated: true, style: { stroke: '#f59e0b', strokeWidth: 2 } },

      { id: 'e-kin-loss', source: 'head_kin', target: 'pinn_loss', style: { stroke: '#f59e0b', strokeDasharray: '5 4', strokeWidth: 1.8 } },
      { id: 'e-ten-loss', source: 'head_ten', target: 'pinn_loss', style: { stroke: '#f59e0b', strokeDasharray: '5 4', strokeWidth: 1.8 } },
      { id: 'e-shm-loss', source: 'head_shm', target: 'pinn_loss', style: { stroke: '#f59e0b', strokeDasharray: '5 4', strokeWidth: 1.8 } },
    ],
    []
  );

  const selected = ARCH_DETAILS[selectedId] || ARCH_DETAILS.mp_layers;

  return (
    <div className="space-y-6">
      {/* Header summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <Cpu className="w-4 h-4 text-indigo-500" /> Parámetros MooringPIGNN
          </div>
          <div className="text-xl font-bold mt-1 text-gray-900 dark:text-white font-mono">
            {paramCount.toLocaleString()}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">6 capas Message Passing · d=128</div>
        </div>
        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <Network className="w-4 h-4 text-cyan-500" /> Topología del Grafo
          </div>
          <div className="text-xl font-bold mt-1 text-gray-900 dark:text-white font-mono">64 Nodos / 126 Aristas</div>
          <div className="text-[11px] text-gray-400 mt-0.5">3×21 nodos línea + 1 super-nodo</div>
        </div>
        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <GitBranch className="w-4 h-4 text-emerald-500" /> Cabezas de Salida
          </div>
          <div className="text-xl font-bold mt-1 text-gray-900 dark:text-white font-mono">3 Cabezales Multi-Tarea</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Cinemática 3D · Tensión · SHM</div>
        </div>
        <div className="bg-white dark:bg-slate-800 p-4 rounded-xl border border-gray-200 dark:border-slate-700">
          <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
            <Activity className="w-4 h-4 text-amber-500" /> Estado Checkpoint PyTorch
          </div>
          <div className={`text-sm font-bold mt-1.5 ${checkpointLoaded ? 'text-emerald-500' : 'text-amber-500'}`}>
            {checkpointLoaded ? 'Checkpoint Entrenado Activo' : 'Sin Checkpoint (Prior + Fallback)'}
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">Ejecuta train_mooring_pinn.py para entrenar</div>
        </div>
      </div>

      {/* Interactive Flow + Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        <div className="xl:col-span-2 bg-slate-950 rounded-2xl border border-slate-800 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-indigo-400" />
                Diagrama Interactivo de la Arquitectura Combinada GNN + PINN
              </h3>
              <p className="text-xs text-slate-400">
                Haz clic en cualquier bloque para inspeccionar tensores, ecuaciones y su archivo Python.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-blue-900/60 text-blue-200 border border-blue-700/60">Entrada / Prior</span>
              <span className="px-2 py-0.5 rounded bg-indigo-900/60 text-indigo-200 border border-indigo-700/60">Rama GNN</span>
              <span className="px-2 py-0.5 rounded bg-cyan-900/60 text-cyan-200 border border-cyan-700/60">Rama PINN Continua</span>
              <span className="px-2 py-0.5 rounded bg-emerald-900/60 text-emerald-200 border border-emerald-700/60">Outputs</span>
              <span className="px-2 py-0.5 rounded bg-amber-900/60 text-amber-200 border border-amber-700/60">Pérdida Física</span>
            </div>
          </div>

          <div className="h-[460px] w-full">
            <ReactFlow
              nodes={nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              fitView
              fitViewOptions={{ padding: 0.14 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1e293b" gap={18} />
              <Controls className="!bg-slate-900 !border-slate-700 !text-slate-200" />
            </ReactFlow>
          </div>
        </div>

        {/* Right Technical Inspector */}
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-5 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-indigo-500">
                  Inspector de Bloque
                </span>
                <h4 className="text-lg font-bold text-gray-900 dark:text-white mt-0.5">{selected.title}</h4>
                <p className="text-xs text-gray-500 dark:text-slate-400">{selected.subtitle}</p>
              </div>
            </div>

            <p className="text-sm text-gray-700 dark:text-slate-300 leading-relaxed">{selected.description}</p>

            <div className="space-y-2 bg-gray-50 dark:bg-slate-900/70 p-3.5 rounded-xl border border-gray-200 dark:border-slate-700">
              <div>
                <div className="text-[10px] font-semibold uppercase text-gray-400">Tensor de Entrada</div>
                <div className="text-xs font-mono text-blue-600 dark:text-blue-400 mt-0.5">{selected.tensorIn}</div>
              </div>
              <div className="flex items-center gap-1 text-gray-400">
                <ArrowRight className="w-3.5 h-3.5" />
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase text-gray-400">Tensor de Salida</div>
                <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400 mt-0.5">{selected.tensorOut}</div>
              </div>
            </div>

            <div className="bg-slate-900 text-amber-200 p-3 rounded-xl font-mono text-xs overflow-x-auto border border-slate-700">
              {selected.formula}
            </div>
          </div>

          <div className="pt-3 border-t border-gray-100 dark:border-slate-700 text-xs text-gray-500 dark:text-slate-400 font-mono">
            Fuente: {selected.moduleRef}
          </div>
        </div>
      </div>

      {/* Topological Graph + Outputs Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-5 space-y-3">
          <h4 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Network className="w-4 h-4 text-indigo-500" />
            Estructura Topológica del Grafo G = (V, E)
          </h4>
          <p className="text-xs text-gray-600 dark:text-slate-400 leading-relaxed">
            Cada una de las 3 líneas (L1 a 180°, L2 a 60°, L3 a 300°) forma una cadena de 21 nodos conectada mediante
            aristas bidireccionales al super-nodo central <strong>P</strong>. Durante los 6 pasos de mensaje, la
            información de carga fluye desde la plataforma hacia cada ancla y regresa permitiendo comparar asimetrías.
          </p>
          <TopologySvg />
        </div>

        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-5 space-y-3">
          <h4 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-emerald-500" />
            Catálogo Completo de Outputs del Sistema Combinado
          </h4>
          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700">
              <div className="font-bold text-gray-900 dark:text-white">1. Geometría y Cinemática 3D (`pos_pred`, `vel_pred`, `acc_pred`)</div>
              <p className="text-gray-600 dark:text-slate-400 mt-1">
                Coordenadas 3D `(3, 21, 3)` [m], velocidades y aceleraciones por nodo desde el ancla (`z = -200m`) al fairlead (`z = -14m`).
              </p>
            </div>
            <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700">
              <div className="font-bold text-gray-900 dark:text-white">2. Tensiones Axiales & Seguridad (`tension_pred`, `SF`)</div>
              <p className="text-gray-600 dark:text-slate-400 mt-1">
                Perfil de tensión `(3, 20)` [kN] en cada segmento, tensión máxima en fairlead, tensión en ancla y factor de seguridad API RP 2SK (`MBL / T_fair`).
              </p>
            </div>
            <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700">
              <div className="font-bold text-gray-900 dark:text-white">3. Zona Touchdown & Fatiga (`touchdown_prob`, `laid_length_m`)</div>
              <p className="text-gray-600 dark:text-slate-400 mt-1">
                Probabilidad nodal de apoyo en lecho marino, longitud apoyada en el fondo y daño por fatiga T-N según DNV-OS-E301.
              </p>
            </div>
            <div className="p-3 rounded-xl bg-gray-50 dark:bg-slate-900/60 border border-gray-200 dark:border-slate-700">
              <div className="font-bold text-gray-900 dark:text-white">4. Diagnóstico SHM Inverso (`shm_probs`, `health_factors`)</div>
              <p className="text-gray-600 dark:text-slate-400 mt-1">
                Probabilidad sobre 5 clases (`HEALTHY`, `PRETENSION_LOSS`, `STIFFNESS_DEGRADATION`, `BIOFOULING`, `LINE_BREAKAGE`) y estimación de degradación `(EA/EA_0, w/w_0)`.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
