import {
  Activity, Box, Cpu, Signal, Waves, ShieldCheck, ArrowRight, Brain, Database, Users, Radio, Map, Boxes,
} from 'lucide-react';
import { useTwinStore } from '../store/twinStore';
import { useProfileStore } from '../store/profileStore';
import { Link } from 'react-router-dom';
import { Glyph } from '../components/ui/Glyph';
import { Badge, Button, Card, CardHeader, PageHeader, Stat, StatusDot } from '../components/ui';

export default function Home() {
  const { isConnected, isSimulating, toggleSimulation, structural, envConditions } = useTwinStore();
  const { profiles, activeProfileId, setActiveProfile } = useProfileStore();
  const activeProfile = profiles.find(p => p.id === activeProfileId) || profiles[0];

  const healthScore = structural ? (100 - structural.shm.damageIndex * 100).toFixed(1) : '99.9';
  const isHealthy = structural ? structural.shm.damageIndex < 0.3 : true;

  const quickLinks = [
    {
      title: 'Monitor 3D',
      icon: Box,
      path: '/twin',
      desc: 'Cinemática 6-DOF en tiempo real, flujo de cámara y geometría 3D.',
    },
    {
      title: 'Gemelos digitales',
      icon: Users,
      path: '/profiles',
      desc: 'Perfiles de activo, parámetros físicos, modelos 3D y paneles.',
    },
    {
      title: 'Entrenamiento IA',
      icon: Brain,
      path: '/training',
      desc: 'Configuración y ejecución de entrenamientos YOLO Pose y detección.',
    },
    {
      title: 'Datasets y pose',
      icon: Database,
      path: '/dataset',
      desc: 'Generación sintética con Blender, partición y edición de etiquetas.',
    },
    {
      title: 'Análisis SHM',
      icon: Activity,
      path: '/shm',
      desc: 'Acumulación de fatiga, curvas S-N y vida útil remanente.',
    },
    {
      title: 'Análisis FEM',
      icon: Boxes,
      path: '/fem',
      desc: 'Malla de elementos finitos, modos propios y respuesta espectral.',
    },
    {
      title: 'Mapa geográfico',
      icon: Map,
      path: '/map',
      desc: 'Posición GPS, deriva y condiciones ambientales del emplazamiento.',
    },
  ];

  const alerts = structural?.shm.alerts ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              <Glyph name={activeProfile?.icon} size={15} />
            </span>
            <span>{activeProfile?.name || 'Plataforma Digital Twin'}</span>
          </span>
        }
        description={
          activeProfile?.description ||
          'Seguimiento óptico por visión artificial, monitorización estructural SHM/FEM y gestión de modelos.'
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={Radio}
              onClick={() => toggleSimulation()}
            >
              {isSimulating ? 'Detener simulación' : 'Simular telemetría'}
            </Button>
            <Link to="/profiles">
              <Button variant="secondary">Gemelos ({profiles.length})</Button>
            </Link>
            <Link to="/twin">
              <Button variant="primary">
                Abrir monitor
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </>
        }
      />

      {/* Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Telemetría y MQTT"
          value={isConnected ? (isSimulating ? 'Simulando 6-DOF' : 'Sincronizado') : 'En espera'}
          hint={activeProfile?.config.mqttTopic || 'oc4/telemetry'}
          icon={Signal}
          tone={isConnected ? 'success' : 'warning'}
        />
        <Stat
          label="Visión IA (YOLO Pose)"
          value={`${activeProfile?.config.aiConfig?.numKeypoints || 11} keypoints`}
          hint={activeProfile?.config.aiConfig?.yoloModelPath || 'Modelo por defecto'}
          icon={Cpu}
        />
        <Stat
          label="Integridad estructural"
          value={`${healthScore}%`}
          hint={`Acero ${activeProfile?.config.physicsConfig?.yieldStrength || 355} MPa`}
          icon={ShieldCheck}
          tone={isHealthy ? 'success' : 'warning'}
        />
        <Stat
          label="Viento / oleaje"
          value={`${envConditions?.windSpeed?.toFixed(1) || 12} m/s · ${envConditions?.waveHeight?.toFixed(1) || 2.5} m`}
          hint={`Escala 1:${activeProfile?.config.physicsConfig?.scaleFactor || 100}`}
          icon={Waves}
        />
      </div>

      {/* Main grid: modules + system state */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Módulos" description="Acceso directo a las herramientas de la plataforma" />
          <div className="grid grid-cols-1 divide-y divide-zinc-200 sm:grid-cols-2 sm:divide-y-0 dark:divide-zinc-800">
            {quickLinks.map((link, i) => (
              <Link
                key={link.path}
                to={link.path}
                className={`group flex items-start justify-between gap-4 p-4 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${
                  i >= 2 ? 'sm:border-t sm:border-zinc-200 dark:sm:border-zinc-800' : ''
                } ${i % 2 === 1 ? 'sm:border-l sm:border-zinc-200 dark:sm:border-zinc-800' : ''}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                    <link.icon className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{link.title}</h3>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{link.desc}</p>
                  </div>
                </div>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-transform group-hover:translate-x-0.5 group-hover:text-zinc-600 dark:text-zinc-600 dark:group-hover:text-zinc-300" />
              </Link>
            ))}
          </div>
        </Card>

        <div className="space-y-6">
          {/* Active twin switcher */}
          <Card>
            <CardHeader
              title="Gemelo activo"
              actions={
                <Link to="/profiles" className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
                  Ver todos
                </Link>
              }
            />
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {profiles.map(p => {
                const selected = p.id === activeProfile?.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveProfile(p.id)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
                        <Glyph name={p.icon} size={13} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-zinc-900 dark:text-zinc-100">{p.name}</p>
                        <p className="truncate font-mono text-[11px] text-zinc-500">{p.config.mqttTopic}</p>
                      </div>
                    </div>
                    {selected && <Badge tone="success" dot>Activo</Badge>}
                  </button>
                );
              })}
            </div>
          </Card>

          {/* System state */}
          <Card>
            <CardHeader title="Estado del sistema" />
            <div className=" space-y-3 p-4 text-xs">
              <div className="flex items-start gap-2.5">
                <StatusDot tone="success" />
                <div>
                  <p className="font-medium text-zinc-900 dark:text-zinc-100">Motor físico y SHM preparado</p>
                  <p className="mt-0.5 text-zinc-500">
                    {activeProfile?.config.physicsConfig?.numMooringLines || 3} líneas de amarre · límite elástico {activeProfile?.config.physicsConfig?.yieldStrength || 355} MPa
                  </p>
                </div>
              </div>

              {alerts.length === 0 ? (
                <div className="flex items-start gap-2.5">
                  <StatusDot tone="neutral" />
                  <p className="text-zinc-500">Sin alertas estructurales activas.</p>
                </div>
              ) : (
                alerts.map((alert, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <StatusDot tone="warning" />
                    <div>
                      <p className="font-medium text-zinc-900 dark:text-zinc-100">Alerta estructural</p>
                      <p className="mt-0.5 text-amber-600 dark:text-amber-400">{alert}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
