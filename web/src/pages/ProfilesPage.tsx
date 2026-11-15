import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import {
  useProfileStore,
  PROFILE_COLORS,
  PROFILE_ICONS,
  TWIN_TEMPLATES,
  DEFAULT_CONFIG,
  type TwinProfile,
  type TwinAssetType
} from '../store/profileStore';
import { usePipelineStore } from '../store/pipelineStore';
import { API_BASE_URL } from '../config/api';
import {
  Plus, Trash2, Copy, ChevronRight, Edit3, Check, X,
  Wifi, Box, Star, ExternalLink, Layers, MapPin, Sliders, Brain, Upload
} from 'lucide-react';

const ASSET_TYPE_LABELS: Record<TwinAssetType, string> = {
  offshore_wind: 'Eólica Offshore',
  onshore_wind: 'Eólica Terrestre',
  civil_structure: 'Infraestructura Civil / SHM',
  robotics: 'Robótica Industrial',
  aerospace_uav: 'Aeroespacial / UAV',
  custom: 'Gemelo Personalizado',
};

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
    duplicateProfile
  } = useProfileStore();
  const { pipelines, loadPipelines } = usePipelineStore();

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<TwinProfile | null>(null);
  const [modalTab, setModalTab] = useState<'general' | 'model3d' | 'connectivity' | 'physics' | 'ai'>('general');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('tpl_oc4_offshore');

  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newIcon, setNewIcon] = useState('🌊');
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
    setNewIcon('🌊');
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

  const getPipelineCount = (profileId: string) => {
    return pipelines.filter(p => p.profileId === profileId).length;
  };

  const activeProfile = profiles.find(p => p.id === activeProfileId);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8 overflow-y-auto h-full pb-12">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white tracking-tight">
            Gemelos Digitales y Perfiles de Activos
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1 text-sm">
            Crea, personaliza y alterna entre múltiples Gemelos Digitales (modelos 3D, física estructural, telemetría MQTT y modelos IA).
          </p>
        </div>
        <button
          id="create-profile-btn"
          onClick={() => {
            resetForm();
            applyTemplateToForm('tpl_oc4_offshore');
            setShowCreateModal(true);
          }}
          className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20"
        >
          <Plus className="w-5 h-5" />
          Nuevo Gemelo Digital
        </button>
      </div>

      {/* Active Profile Banner */}
      {activeProfile && (
        <div className="bg-gradient-to-r from-emerald-500/10 via-blue-500/5 to-teal-500/10 border border-emerald-500/30 rounded-2xl p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shadow-inner"
              style={{ backgroundColor: activeProfile.color + '25', border: `1px solid ${activeProfile.color}40` }}
            >
              {activeProfile.icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-emerald-500" />
                <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                  Gemelo Digital Activo en el Sistema
                </span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                  {ASSET_TYPE_LABELS[activeProfile.assetType || 'offshore_wind']}
                </span>
              </div>
              <p className="text-xl font-bold text-gray-900 dark:text-white mt-0.5">
                {activeProfile.name}
              </p>
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-400 mt-1">
                <span className="flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5 text-blue-400" />
                  {activeProfile.config.locationName}
                </span>
                <span className="flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5 text-purple-400" />
                  3D: {activeProfile.config.model3dUrl}
                </span>
                <span className="flex items-center gap-1">
                  <Brain className="w-3.5 h-3.5 text-emerald-400" />
                  IA: {activeProfile.config.aiConfig?.numKeypoints || 11} kpts
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => openEdit(activeProfile)}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 flex items-center gap-1.5"
            >
              <Sliders className="w-3.5 h-3.5" /> Configurar Parámetros
            </button>
            <button
              onClick={() => navigate(`/profiles/${activeProfile.id}`)}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Abrir Estudio del Gemelo
            </button>
          </div>
        </div>
      )}

      {/* Profiles Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {profiles.map(profile => (
          <div
            key={profile.id}
            className={`group relative bg-white dark:bg-slate-800 rounded-2xl border-2 transition-all duration-300 hover:shadow-xl overflow-hidden ${
              activeProfileId === profile.id
                ? 'border-emerald-500 shadow-lg shadow-emerald-500/10'
                : 'border-gray-100 dark:border-slate-700 hover:border-blue-500/50'
            }`}
          >
            <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${profile.color}, ${profile.color}88)` }} />

            <div className="p-6">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-sm"
                    style={{ backgroundColor: profile.color + '15', border: `1px solid ${profile.color}30` }}
                  >
                    {profile.icon}
                  </div>
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400">
                      {ASSET_TYPE_LABELS[profile.assetType || 'offshore_wind']}
                    </span>
                    <h3 className="font-bold text-gray-900 dark:text-white text-lg leading-tight">
                      {profile.name}
                    </h3>
                  </div>
                </div>
                {activeProfileId === profile.id && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Activo
                  </span>
                )}
              </div>

              <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 line-clamp-2 min-h-[2rem]">
                {profile.description || 'Sin descripción'}
              </p>

              {/* Quick specs */}
              <div className="grid grid-cols-2 gap-2.5 mb-5 text-xs">
                <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                  <div className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                    <Wifi className="w-3 h-3 text-blue-400" /> Tópico MQTT
                  </div>
                  <p className="font-mono text-gray-700 dark:text-gray-200 mt-0.5 truncate">
                    {profile.config.mqttTopic}
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                  <div className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                    <Box className="w-3 h-3 text-purple-400" /> Modelo 3D
                  </div>
                  <p className="font-mono text-gray-700 dark:text-gray-200 mt-0.5 truncate">
                    {profile.config.model3dUrl?.replace('/models/', '') || 'OC4.glb'}
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                  <div className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                    <Sliders className="w-3 h-3 text-amber-400" /> Escala / Acero
                  </div>
                  <p className="font-medium text-gray-700 dark:text-gray-200 mt-0.5 truncate">
                    1:{profile.config.physicsConfig?.scaleFactor ?? 100} · {profile.config.physicsConfig?.yieldStrength ?? 355} MPa
                  </p>
                </div>
                <div className="p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                  <div className="flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
                    <Brain className="w-3 h-3 text-emerald-400" /> IA Keypoints
                  </div>
                  <p className="font-medium text-gray-700 dark:text-gray-200 mt-0.5 truncate">
                    {profile.config.aiConfig?.numKeypoints ?? 11} pts ({getPipelineCount(profile.id)} flows)
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveProfile(profile.id)}
                  disabled={activeProfileId === profile.id}
                  className={`flex-1 py-2.5 rounded-xl text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                    activeProfileId === profile.id
                      ? 'bg-emerald-50 text-emerald-500 dark:bg-emerald-500/10 cursor-default'
                      : 'bg-blue-50 hover:bg-blue-100 text-blue-600 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 dark:text-blue-400'
                  }`}
                >
                  {activeProfileId === profile.id ? (
                    <>
                      <Check className="w-4 h-4" /> Activo
                    </>
                  ) : (
                    <>
                      <ChevronRight className="w-4 h-4" /> Activar Gemelo
                    </>
                  )}
                </button>
                <button
                  onClick={() => navigate(`/profiles/${profile.id}`)}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-400 hover:to-purple-400 text-white text-xs font-bold transition-all shadow-sm shrink-0"
                  title="Abrir Dashboard, Node Editor y Configuración"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Estudio
                </button>
                <button
                  onClick={() => openEdit(profile)}
                  className="p-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-500 dark:text-gray-300 transition-all"
                  title="Configurar Gemelo"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => duplicateProfile(profile.id)}
                  className="p-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-500 dark:text-gray-300 transition-all"
                  title="Duplicar"
                >
                  <Copy className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setDeleteConfirmId(profile.id)}
                  className="p-2.5 rounded-xl bg-gray-50 hover:bg-red-50 dark:bg-slate-700 dark:hover:bg-red-500/10 text-gray-500 hover:text-red-500 dark:text-gray-400 transition-all"
                  title="Eliminar"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {deleteConfirmId === profile.id && (
              <div className="absolute inset-0 bg-slate-900/95 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10 rounded-2xl">
                <Trash2 className="w-10 h-10 text-red-400 mb-3" />
                <p className="text-white font-semibold mb-1">¿Eliminar este Gemelo Digital?</p>
                <p className="text-gray-400 text-xs mb-5 text-center">Esta acción no se puede deshacer.</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setDeleteConfirmId(null)}
                    className="px-5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={() => {
                      deleteProfile(profile.id);
                      setDeleteConfirmId(null);
                    }}
                    className="px-5 py-2 rounded-xl bg-red-500 hover:bg-red-400 text-white text-xs font-medium"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Multi-Tab Create / Edit Modal */}
      {(showCreateModal || editingProfile) && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-slate-900 rounded-3xl border border-gray-200 dark:border-slate-700 max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-200 dark:border-slate-800 flex items-center justify-between bg-gray-50 dark:bg-slate-950">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                  {editingProfile ? `Configurar Gemelo: ${editingProfile.name}` : 'Crear Nuevo Gemelo Digital'}
                </h3>
                <p className="text-xs text-slate-400">
                  Personaliza la geometría 3D, el motor de cálculo estructural, la telemetría MQTT y el modelo IA.
                </p>
              </div>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setEditingProfile(null);
                  resetForm();
                }}
                className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-slate-800 transition-all"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            {/* Template Selector Bar (only when creating) */}
            {!editingProfile && (
              <div className="px-6 py-3 bg-slate-900/50 border-b border-slate-800">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                  Plantillas Preconfiguradas de Gemelo Digital:
                </div>
                <div className="flex flex-wrap gap-2">
                  {TWIN_TEMPLATES.map(tpl => (
                    <button
                      key={tpl.id}
                      onClick={() => applyTemplateToForm(tpl.id)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium border transition-all ${
                        selectedTemplateId === tpl.id
                          ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                          : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                      }`}
                    >
                      <span>{tpl.icon}</span>
                      <span>{tpl.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Modal Navigation Tabs */}
            <div className="px-6 pt-2 border-b border-gray-200 dark:border-slate-800 flex gap-2 overflow-x-auto bg-gray-50/50 dark:bg-slate-900">
              {[
                { id: 'general', label: '1. General y Ubicación' },
                { id: 'model3d', label: '2. Modelo 3D y Escena' },
                { id: 'physics', label: '3. Física y Cálculo SHM' },
                { id: 'connectivity', label: '4. Telemetría MQTT y Cámara' },
                { id: 'ai', label: '5. Modelo IA y Keypoints' },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setModalTab(t.id as any)}
                  className={`px-3.5 py-2.5 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap ${
                    modalTab === t.id
                      ? 'border-blue-500 text-blue-500'
                      : 'border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto flex-1 space-y-5 text-xs">
              {modalTab === 'general' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Nombre del Gemelo Digital</label>
                      <input
                        type="text"
                        value={newName}
                        onChange={e => setNewName(e.target.value)}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                        placeholder="Ej. Turbina OC4 #2, Puente Colgante..."
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Categoría / Dominio del Activo</label>
                      <select
                        value={newAssetType}
                        onChange={e => setNewAssetType(e.target.value as TwinAssetType)}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
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
                    <label className="block font-semibold text-slate-300 mb-1">Descripción Técnica</label>
                    <textarea
                      value={newDesc}
                      onChange={e => setNewDesc(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Ubicación Geográfica</label>
                      <input
                        type="text"
                        value={draftConfig.locationName}
                        onChange={e => setDraftConfig({ ...draftConfig, locationName: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Latitud (°)</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Longitud (°)</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-2">Icono</label>
                      <div className="flex gap-2 flex-wrap">
                        {PROFILE_ICONS.map(icon => (
                          <button
                            key={icon}
                            onClick={() => setNewIcon(icon)}
                            className={`w-9 h-9 rounded-xl flex items-center justify-center text-base transition-all ${
                              newIcon === icon
                                ? 'bg-blue-500/20 ring-2 ring-blue-500 scale-110'
                                : 'bg-slate-800 hover:bg-slate-700'
                            }`}
                          >
                            {icon}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-2">Color Identificativo</label>
                      <div className="flex gap-2 flex-wrap">
                        {PROFILE_COLORS.map(color => (
                          <button
                            key={color}
                            onClick={() => setNewColor(color)}
                            className={`w-8 h-8 rounded-lg transition-all ${
                              newColor === color ? 'ring-2 ring-white scale-110' : ''
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
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Modelo 3D (GLB o Procedural)</label>
                      <select
                        value={draftConfig.model3dUrl}
                        onChange={e => setDraftConfig({ ...draftConfig, model3dUrl: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      >
                        <option value="/models/OC4.glb">/models/OC4.glb (Turbina Offshore OC4)</option>
                        <option value="/models/OC4-modal.glb">/models/OC4-modal.glb (Deformación Modal)</option>
                        <option value="procedural:bridge">procedural:bridge (Viaducto / Puente SHM)</option>
                        <option value="procedural:robot_arm">procedural:robot_arm (Brazo Robótico 6-DOF)</option>
                        <option value="procedural:uav">procedural:uav (Dron / UAV Cuadricóptero)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Subir Modelo .GLB Personalizado</label>
                      <label className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 cursor-pointer">
                        <Upload className="w-4 h-4" />
                        <span>Seleccionar archivo .GLB / .GLTF</span>
                        <input type="file" accept=".glb,.gltf" className="hidden" onChange={handleUpload3DModel} />
                      </label>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Escena Blender (.blend)</label>
                      <input
                        type="text"
                        value={draftConfig.blenderScene}
                        onChange={e => setDraftConfig({ ...draftConfig, blenderScene: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block font-semibold text-slate-300 mb-1">Nodo Animado / Rotor</label>
                      <input
                        type="text"
                        value={draftConfig.animatedNodeName || ''}
                        onChange={e => setDraftConfig({ ...draftConfig, animatedNodeName: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div className="flex items-center pt-5">
                      <label className="flex items-center gap-2 cursor-pointer text-slate-200">
                        <input
                          type="checkbox"
                          checked={draftConfig.enableBladeRotation}
                          onChange={e => setDraftConfig({ ...draftConfig, enableBladeRotation: e.target.checked })}
                          className="rounded"
                        />
                        Activar rotación de rotor / partes móviles
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'physics' && (
                <div className="space-y-4">
                  <p className="text-slate-400">
                    Estos parámetros alimentan el motor de cálculo en tiempo real (<code>StructuralEngine.ts</code>) y el analizador SHM del backend (<code>shm_analyzer.py</code>).
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Factor Escala (λ)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.scaleFactor}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, scaleFactor: Number(e.target.value) },
                          })
                        }
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Altura Estructura (m)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Diámetro Base (m)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Espesor Pared (m)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Límite Elástico (MPa)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.yieldStrength}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, yieldStrength: Number(e.target.value) },
                          })
                        }
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Módulo Young (GPa)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.youngsModulus}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, youngsModulus: Number(e.target.value) },
                          })
                        }
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Nº Líneas / Apoyos</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Pretensión Línea (N)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Rigidez Horiz. Kh (N/m)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.horizontalStiffness}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, horizontalStiffness: Number(e.target.value) },
                          })
                        }
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Masa Superior RNA (kg)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Vida Diseño (años)</label>
                      <input
                        type="number"
                        value={draftConfig.physicsConfig.designLifeYears}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            physicsConfig: { ...draftConfig.physicsConfig, designLifeYears: Number(e.target.value) },
                          })
                        }
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Exponente Fatiga (m)</label>
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
                        className="w-full px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'connectivity' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">Broker MQTT</label>
                      <input
                        type="text"
                        value={draftConfig.mqttBroker}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttBroker: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Puerto MQTT</label>
                      <input
                        type="number"
                        value={draftConfig.mqttPort}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttPort: Number(e.target.value) })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Tópico Telemetría MQTT</label>
                      <input
                        type="text"
                        value={draftConfig.mqttTopic}
                        onChange={e => setDraftConfig({ ...draftConfig, mqttTopic: e.target.value })}
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">Viento Nominal (m/s)</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Altura de Ola Hs (m)</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Corriente Marina (m/s)</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                  </div>
                </div>
              )}

              {modalTab === 'ai' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">Ruta Modelo YOLO Pose (.pt)</label>
                      <input
                        type="text"
                        value={draftConfig.aiConfig.yoloModelPath}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, yoloModelPath: e.target.value },
                          })
                        }
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Dataset Asociado</label>
                      <input
                        type="text"
                        value={draftConfig.aiConfig.datasetName}
                        onChange={e =>
                          setDraftConfig({
                            ...draftConfig,
                            aiConfig: { ...draftConfig.aiConfig, datasetName: e.target.value },
                          })
                        }
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="block text-slate-400 mb-1">Nº de Keypoints 3D</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Umbral Confianza Box</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Umbral Confianza Keypoint</label>
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
                        className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-gray-200 dark:border-slate-800 flex gap-3 bg-gray-50 dark:bg-slate-950">
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setEditingProfile(null);
                  resetForm();
                }}
                className="flex-1 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-700 dark:text-gray-300 font-medium text-xs"
              >
                Cancelar
              </button>
              <button
                id="save-profile-btn"
                onClick={editingProfile ? handleUpdate : handleCreate}
                disabled={!newName.trim()}
                className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold shadow-lg shadow-blue-500/20 disabled:opacity-50 text-xs"
              >
                {editingProfile ? 'Guardar Cambios en Gemelo Digital' : 'Crear y Activar Gemelo Digital'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
