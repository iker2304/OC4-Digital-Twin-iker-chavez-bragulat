import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import {
  useProfileStore,
  PROFILE_COLORS,
  TWIN_TEMPLATES,
  DEFAULT_CONFIG,
  type TwinProfile,
  type TwinAssetType,
} from '../store/profileStore';
import { usePipelineStore } from '../store/pipelineStore';
import { API_BASE_URL } from '../config/api';
import { Plus, Trash2, Copy, Edit3, Check, X, ExternalLink, Sliders, Upload } from 'lucide-react';
import { Glyph, TWIN_GLYPH_OPTIONS } from '../components/ui/Glyph';
import { Badge, Button, Card, PageHeader, Tabs } from '../components/ui';

const ASSET_TYPE_LABELS: Record<TwinAssetType, string> = {
  offshore_wind: 'Eólica offshore',
  onshore_wind: 'Eólica terrestre',
  civil_structure: 'Infraestructura civil / SHM',
  robotics: 'Robótica industrial',
  aerospace_uav: 'Aeroespacial / UAV',
  custom: 'Gemelo personalizado',
};

type ModalTab = 'general' | 'model3d' | 'physics' | 'connectivity' | 'ai';

export default function ProfilesPage() {
  const { currentUser } = useAuthStore();
  const navigate = useNavigate();
  const {
    profiles,
    activeProfileId,
    loadProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    setActiveProfile,
    duplicateProfile,
  } = useProfileStore();
  const { pipelines, loadPipelines } = usePipelineStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<TwinProfile | null>(null);
  const [modalTab, setModalTab] = useState<ModalTab>('general');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('tpl_oc4_offshore');

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newIcon, setNewIcon] = useState('waves');
  const [newColor, setNewColor] = useState(PROFILE_COLORS[0]);
  const [newAssetType, setNewAssetType] = useState<TwinAssetType>('offshore_wind');
  const [draftConfig, setDraftConfig] = useState<TwinProfile['config']>(
    JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    if (currentUser) {
      loadProfiles(currentUser.id);
      loadPipelines(currentUser.id);
    }
  }, [currentUser, loadProfiles, loadPipelines]);

  const applyTemplateToForm = (tplId: string) => {
    setSelectedTemplateId(tplId);
    const tpl = TWIN_TEMPLATES.find(t => t.id === tplId);
    if (tpl) {
      setNewName(tpl.name);
      setNewDesc(tpl.description);
      setNewIcon(tpl.icon);
      setNewColor(tpl.color);
      setNewAssetType(tpl.assetType);
      setDraftConfig(JSON.parse(JSON.stringify(tpl.config)));
    }
  };

  const handleCreate = () => {
    if (!currentUser || !newName.trim()) return;
    const created = createProfile(
      currentUser.id,
      newName.trim(),
      newDesc.trim(),
      newIcon,
      newColor,
      selectedTemplateId,
      draftConfig,
      newAssetType
    );
    setActiveProfile(created.id);
    setShowCreateModal(false);
    resetForm();
  };

  const handleUpdate = () => {
    if (!editingProfile || !newName.trim()) return;
    updateProfile(editingProfile.id, {
      name: newName.trim(),
      description: newDesc.trim(),
      icon: newIcon,
      color: newColor,
      assetType: newAssetType,
      config: draftConfig,
    });
    setEditingProfile(null);
    resetForm();
  };

  const openEdit = (profile: TwinProfile) => {
    setEditingProfile(profile);
    setModalTab('general');
    setNewName(profile.name);
    setNewDesc(profile.description);
    setNewIcon(profile.icon);
    setNewColor(profile.color);
    setNewAssetType(profile.assetType || 'offshore_wind');
    setDraftConfig(JSON.parse(JSON.stringify(profile.config)));
  };

  const resetForm = () => {
    setModalTab('general');
    setSelectedTemplateId('tpl_oc4_offshore');
    setNewName('');
    setNewDesc('');
    setNewIcon('waves');
    setNewColor(PROFILE_COLORS[0]);
    setNewAssetType('offshore_wind');
    setDraftConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  };

  const handleUpload3DModel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch(`${API_BASE_URL}/api/models/upload-3d`, {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        const uploaded = await res.json();
        setDraftConfig(prev => ({ ...prev, model3dUrl: uploaded.url }));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const getPipelineCount = (profileId: string) =>
    pipelines.filter(p => p.profileId === profileId).length;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader
        title="Gemelos digitales"
        description="Perfiles de activo, geometría 3D, propiedades físicas, telemetría MQTT y modelos de visión."
        actions={
          <Button
            id="create-profile-btn"
            variant="primary"
            icon={Plus}
            onClick={() => {
              resetForm();
              applyTemplateToForm('tpl_oc4_offshore');
              setShowCreateModal(true);
            }}
          >
            Nuevo gemelo
          </Button>
        }
      />

      {/* Profiles Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {profiles.map(profile => {
          const isActive = activeProfileId === profile.id;
          return (
            <Card
              key={profile.id}
              className={`relative flex flex-col justify-between p-5 transition-colors ${
                isActive ? 'ring-1 ring-zinc-900 dark:ring-zinc-100' : ''
              }`}
            >
              <div>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-700 dark:border-zinc-800 dark:text-zinc-200"
                      style={{ borderLeftWidth: 3, borderLeftColor: profile.color }}
                    >
                      <Glyph name={profile.icon} size={17} />
                    </span>
                    <div className="min-w-0">
                      <span className="block truncate text-[11px] font-medium text-zinc-500">
                        {ASSET_TYPE_LABELS[profile.assetType || 'offshore_wind']}
                      </span>
                      <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                        {profile.name}
                      </h3>
                    </div>
                  </div>
                  {isActive && (
                    <Badge tone="success" dot>
                      Activo
                    </Badge>
                  )}
                </div>

                <p className="mb-4 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                  {profile.description || 'Sin descripción'}
                </p>

                <dl className="mb-5 grid grid-cols-2 gap-x-4 gap-y-2 border-y border-zinc-100 py-3 text-xs dark:border-zinc-800/80">
                  <div>
                    <dt className="text-[11px] text-zinc-400">Tópico MQTT</dt>
                    <dd className="mt-0.5 truncate font-mono text-zinc-700 dark:text-zinc-300">
                      {profile.config.mqttTopic}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-zinc-400">Modelo 3D</dt>
                    <dd className="mt-0.5 truncate font-mono text-zinc-700 dark:text-zinc-300">
                      {profile.config.model3dUrl?.replace('/models/', '') || 'OC4.glb'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-zinc-400">Escala · Acero</dt>
                    <dd className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">
                      1:{profile.config.physicsConfig?.scaleFactor ?? 100} ·{' '}
                      {profile.config.physicsConfig?.yieldStrength ?? 355} MPa
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] text-zinc-400">Keypoints · Flujos</dt>
                    <dd className="mt-0.5 truncate text-zinc-700 dark:text-zinc-300">
                      {profile.config.aiConfig?.numKeypoints ?? 11} pts · {getPipelineCount(profile.id)}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant={isActive ? 'secondary' : 'primary'}
                  disabled={isActive}
                  onClick={() => setActiveProfile(profile.id)}
                  className="flex-1 justify-center"
                >
                  {isActive ? (
                    <>
                      <Check className="h-3.5 w-3.5" /> Activo
                    </>
                  ) : (
                    'Activar'
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={ExternalLink}
                  onClick={() => navigate(`/profiles/${profile.id}`)}
                  title="Abrir estudio del gemelo"
                >
                  Estudio
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  icon={Edit3}
                  onClick={() => openEdit(profile)}
                  title="Configurar"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon={Copy}
                  onClick={() => duplicateProfile(profile.id)}
                  title="Duplicar"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  icon={Trash2}
                  onClick={() => setDeleteConfirmId(profile.id)}
                  title="Eliminar"
                />
              </div>

              {deleteConfirmId === profile.id && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-white/95 p-6 text-center dark:bg-zinc-950/95">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    ¿Eliminar este gemelo digital?
                  </p>
                  <p className="mt-1 mb-4 text-xs text-zinc-500">Esta acción no se puede deshacer.</p>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setDeleteConfirmId(null)}>
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        deleteProfile(profile.id);
                        setDeleteConfirmId(null);
                      }}
                    >
                      Eliminar
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Create / Edit Modal */}
      {(showCreateModal || editingProfile) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
              <div>
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {editingProfile ? `Configurar: ${editingProfile.name}` : 'Nuevo gemelo digital'}
                </h3>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Geometría 3D, cálculo estructural, telemetría MQTT y modelo IA.
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                icon={X}
                onClick={() => {
                  setShowCreateModal(false);
                  setEditingProfile(null);
                  resetForm();
                }}
              />
            </div>

            {/* Template selector (only on create) */}
            {!editingProfile && (
              <div className="border-b border-zinc-200 bg-zinc-50 px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950/60">
                <div className="mb-2 ui-eyebrow">Plantillas</div>
                <div className="flex flex-wrap gap-1.5">
                  {TWIN_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => applyTemplateToForm(tpl.id)}
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                        selectedTemplateId === tpl.id
                          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                          : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
                      }`}
                    >
                      <Glyph name={tpl.icon} size={13} />
                      <span>{tpl.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="border-b border-zinc-200 px-6 py-2.5 dark:border-zinc-800">
              <Tabs<ModalTab>
                value={modalTab}
                onChange={setModalTab}
                items={[
                  { value: 'general', label: 'General' },
                  { value: 'model3d', label: 'Modelo 3D' },
                  { value: 'physics', label: 'Física y SHM' },
                  { value: 'connectivity', label: 'MQTT y entorno' },
                  { value: 'ai', label: 'Visión IA' },
                ]}
              />
            </div>

            {/* Body */}
            <div className="flex-1 space-y-4 overflow-y-auto p-6 text-xs">
              {modalTab === 'general' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="ui-label">Nombre del gemelo</label>
                      <input
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        className="ui-input"
                        placeholder="Ej. Turbina OC4 #2"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Categoría del activo</label>
                      <select
                        value={newAssetType}
                        onChange={e => setNewAssetType(e.target.value as TwinAssetType)}
                        className="ui-input"
                      >
                        {Object.entries(ASSET_TYPE_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="ui-label">Descripción</label>
                    <textarea
                      value={newDesc}
                      onChange={e => setNewDesc(e.target.value)}
                      rows={2}
                      className="ui-input"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div>
                      <label className="ui-label">Ubicación geográfica</label>
                      <input
                        type="text"
                        value={draftConfig.locationName}
                        onChange={e => setDraftConfig({ ...draftConfig, locationName: e.target.value })}
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Latitud (°)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={draftConfig.coordinates?.[0] ?? 55.0}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            coordinates: [Number(e.target.value), draftConfig.coordinates?.[1] ?? 2.0],
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Longitud (°)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={draftConfig.coordinates?.[1] ?? 2.0}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            coordinates: [draftConfig.coordinates?.[0] ?? 55.0, Number(e.target.value)],
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 pt-1 md:grid-cols-2">
                    <div>
                      <label className="ui-label">Icono</label>
                      <div className="flex flex-wrap gap-1.5">
                        {TWIN_GLYPH_OPTIONS.map(icon => (
                          <button
                            key={icon}
                            type="button"
                            onClick={() => setNewIcon(icon)}
                            className={`flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
                              newIcon === icon
                                ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                                : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-800'
                            }`}
                          >
                            <Glyph name={icon} size={15} />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="ui-label">Color identificativo</label>
                      <div className="flex flex-wrap gap-1.5">
                        {PROFILE_COLORS.map(color => (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setNewColor(color)}
                            className={`h-7 w-7 rounded-md transition-transform ${
                              newColor === color ? 'ring-2 ring-zinc-900 ring-offset-2 dark:ring-zinc-100 dark:ring-offset-zinc-900' : ''
                            }`}
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'model3d' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="ui-label">Modelo 3D (GLB o procedural)</label>
                      <select
                        value={draftConfig.model3dUrl}
                        onChange={e => setDraftConfig({ ...draftConfig, model3dUrl: e.target.value })}
                        className="ui-input"
                      >
                        <option value="/models/OC4.glb">/models/OC4.glb (Turbina Offshore OC4)</option>
                        <option value="/models/OC4-modal.glb">/models/OC4-modal.glb (Deformación Modal)</option>
                        <option value="procedural:bridge">procedural:bridge (Viaducto / Puente SHM)</option>
                        <option value="procedural:robot_arm">procedural:robot_arm (Brazo Robótico 6-DOF)</option>
                        <option value="procedural:uav">procedural:uav (Dron / UAV Cuadricóptero)</option>
                      </select>
                    </div>
                    <div>
                      <label className="ui-label">Subir modelo .GLB personalizado</label>
                      <label className="flex h-[38px] cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800">
                        <Upload className="h-3.5 w-3.5" />
                        <span>Seleccionar archivo .GLB / .GLTF</span>
                        <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleUpload3DModel} />
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div>
                      <label className="ui-label">Escena Blender (.blend)</label>
                      <input
                        type="text"
                        value={draftConfig.blenderScene}
                        onChange={e => setDraftConfig({ ...draftConfig, blenderScene: e.target.value })}
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Nodo animado / rotor</label>
                      <input
                        type="text"
                        value={draftConfig.animatedNodeName || ''}
                        onChange={e => setDraftConfig({ ...draftConfig, animatedNodeName: e.target.value })}
                        className="ui-input"
                      />
                    </div>
                    <div className="flex items-end pb-2">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={draftConfig.enableBladeRotation}
                          onChange={e => setDraftConfig({ ...draftConfig, enableBladeRotation: e.target.checked })}
                          className="rounded"
                        />
                        Rotación de partes móviles
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'physics' && (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-500">
                    Parámetros empleados por el motor físico (<code>StructuralEngine.ts</code>) y el analizador SHM.
                  </p>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div>
                      <label className="ui-label">Factor escala (λ)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.scaleFactor}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, scaleFactor: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Altura estructura (m)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={draftConfig.physicsConfig.structureHeight}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, structureHeight: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Diámetro base (m)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={draftConfig.physicsConfig.baseDiameter}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, baseDiameter: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Espesor pared (m)</label>
                      <input
                        type="number"
                        step="0.0005"
                        value={draftConfig.physicsConfig.wallThickness}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, wallThickness: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Límite elástico (MPa)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.yieldStrength}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, yieldStrength: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Módulo Young (GPa)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.youngsModulus}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, youngsModulus: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Nº líneas / apoyos</label>
                      <input
                        type="number"
                        min={1}
                        max={12}
                        value={draftConfig.physicsConfig.numMooringLines}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, numMooringLines: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Pretensión línea (N)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={draftConfig.physicsConfig.linePretension}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, linePretension: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Rigidez horiz. Kh (N/m)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.horizontalStiffness}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, horizontalStiffness: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Masa superior RNA (kg)</label>
                      <input
                        type="number"
                        step="0.05"
                        value={draftConfig.physicsConfig.topMass}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, topMass: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Vida diseño (años)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.designLifeYears}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, designLifeYears: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Exponente fatiga (m)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={draftConfig.physicsConfig.parisExponentM}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, parisExponentM: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'connectivity' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div>
                      <label className="ui-label">Broker MQTT</label>
                      <input
                        type="text"
                        value={draftConfig.mqttBroker}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttBroker: e.target.value })}
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Puerto MQTT</label>
                      <input
                        type="number"
                        value={draftConfig.mqttPort}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttPort: Number(e.target.value) })}
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Tópico telemetría MQTT</label>
                      <input
                        type="text"
                        value={draftConfig.mqttTopic}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttTopic: e.target.value })}
                        className="ui-input font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div>
                      <label className="ui-label">Viento nominal (m/s)</label>
                      <input
                        type="number"
                        step="0.5"
                        value={draftConfig.environmentalDefaults.windSpeed}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            environmentalDefaults: {
                              ...draftConfig.environmentalDefaults,
                              windSpeed: Number(e.target.value),
                            },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Altura de ola Hs (m)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={draftConfig.environmentalDefaults.waveHeight}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            environmentalDefaults: {
                              ...draftConfig.environmentalDefaults,
                              waveHeight: Number(e.target.value),
                            },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Corriente marina (m/s)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={draftConfig.environmentalDefaults.currentSpeed}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            environmentalDefaults: {
                              ...draftConfig.environmentalDefaults,
                              currentSpeed: Number(e.target.value),
                            },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'ai' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div>
                      <label className="ui-label">Ruta modelo YOLO Pose (.pt)</label>
                      <input
                        type="text"
                        value={draftConfig.aiConfig.yoloModelPath}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, yoloModelPath: e.target.value },
                          })
                        }
                        className="ui-input font-mono"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Dataset asociado</label>
                      <input
                        type="text"
                        value={draftConfig.aiConfig.datasetName}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, datasetName: e.target.value },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="ui-label">Nº de keypoints 3D</label>
                      <input
                        type="number"
                        min={1}
                        max={64}
                        value={draftConfig.aiConfig.numKeypoints}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, numKeypoints: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Umbral confianza caja</label>
                      <input
                        type="number"
                        step="0.05"
                        min={0.05}
                        max={0.95}
                        value={draftConfig.aiConfig.confidenceThreshold}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, confidenceThreshold: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                    <div>
                      <label className="ui-label">Umbral confianza keypoint</label>
                      <input
                        type="number"
                        step="0.05"
                        min={0.05}
                        max={0.95}
                        value={draftConfig.aiConfig.keypointThreshold}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, keypointThreshold: Number(e.target.value) },
                          })
                        }
                        className="ui-input"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
              <Button
                variant="secondary"
                onClick={() => {
                  setShowCreateModal(false);
                  setEditingProfile(null);
                  resetForm();
                }}
              >
                Cancelar
              </Button>
              <Button
                id="save-profile-btn"
                variant="primary"
                onClick={editingProfile ? handleUpdate : handleCreate}
                disabled={!newName.trim()}
                icon={Sliders}
              >
                {editingProfile ? 'Guardar cambios' : 'Crear y activar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
