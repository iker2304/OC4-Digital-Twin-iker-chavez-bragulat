import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useProfileStore, PROFILE_COLORS, PROFILE_ICONS, type TwinProfile } from '../store/profileStore';
import { usePipelineStore } from '../store/pipelineStore';
import {
    Plus, Trash2, Copy, Settings, ChevronRight, Edit3, Check, X,
    Radio, Wifi, Box, Star, Clock, ExternalLink
} from 'lucide-react';

export default function ProfilesPage() {
    const { currentUser } = useAuthStore();
    const navigate = useNavigate();
    const { profiles, activeProfileId, loadProfiles, createProfile, updateProfile, deleteProfile, setActiveProfile, duplicateProfile } = useProfileStore();
    const { pipelines, loadPipelines } = usePipelineStore();

    const [showCreateModal, setShowCreateModal] = useState(false);
    const [editingProfile, setEditingProfile] = useState<TwinProfile | null>(null);
    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newIcon, setNewIcon] = useState('🌊');
    const [newColor, setNewColor] = useState(PROFILE_COLORS[0]);
    const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

    useEffect(() => {
        if (currentUser) {
            loadProfiles(currentUser.id);
            loadPipelines(currentUser.id);
        }
    }, [currentUser, loadProfiles, loadPipelines]);

    const handleCreate = () => {
        if (!currentUser || !newName.trim()) return;
        createProfile(currentUser.id, newName.trim(), newDesc.trim(), newIcon, newColor);
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
        });
        setEditingProfile(null);
        resetForm();
    };

    const openEdit = (profile: TwinProfile) => {
        setEditingProfile(profile);
        setNewName(profile.name);
        setNewDesc(profile.description);
        setNewIcon(profile.icon);
        setNewColor(profile.color);
    };

    const resetForm = () => {
        setNewName('');
        setNewDesc('');
        setNewIcon('🌊');
        setNewColor(PROFILE_COLORS[0]);
    };

    const getPipelineCount = (profileId: string) => {
        return pipelines.filter(p => p.profileId === profileId).length;
    };

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-8">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-extrabold text-gray-900 dark:text-white tracking-tight">
                        Digital Twin Profiles
                    </h1>
                    <p className="text-gray-500 dark:text-gray-400 mt-1">
                        Create and manage different configurations for your digital twins
                    </p>
                </div>
                <button
                    id="create-profile-btn"
                    onClick={() => { resetForm(); setShowCreateModal(true); }}
                    className="inline-flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold rounded-xl transition-all shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 hover:-translate-y-0.5"
                >
                    <Plus className="w-5 h-5" />
                    New Profile
                </button>
            </div>

            {/* Active Profile Banner */}
            {activeProfileId && profiles.find(p => p.id === activeProfileId) && (
                <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20 rounded-2xl p-5 flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
                        style={{ backgroundColor: profiles.find(p => p.id === activeProfileId)!.color + '20' }}>
                        {profiles.find(p => p.id === activeProfileId)!.icon}
                    </div>
                    <div className="flex-1">
                        <div className="flex items-center gap-2">
                            <Star className="w-4 h-4 text-emerald-500" />
                            <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">Active Profile</span>
                        </div>
                        <p className="text-lg font-bold text-gray-900 dark:text-white">
                            {profiles.find(p => p.id === activeProfileId)!.name}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 text-emerald-500">
                        <Radio className="w-5 h-5 animate-pulse" />
                        <span className="text-sm font-medium">Connected</span>
                    </div>
                </div>
            )}

            {/* Profiles Grid */}
            {profiles.length === 0 ? (
                <div className="text-center py-20">
                    <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gray-100 dark:bg-slate-800 flex items-center justify-center">
                        <Box className="w-10 h-10 text-gray-400" />
                    </div>
                    <h3 className="text-xl font-bold text-gray-700 dark:text-gray-300 mb-2">No profiles yet</h3>
                    <p className="text-gray-500 mb-6">Create your first digital twin profile to get started</p>
                    <button
                        onClick={() => { resetForm(); setShowCreateModal(true); }}
                        className="inline-flex items-center gap-2 px-5 py-3 bg-blue-500 hover:bg-blue-400 text-white font-semibold rounded-xl transition-all"
                    >
                        <Plus className="w-5 h-5" /> Create First Profile
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {profiles.map(profile => (
                        <div
                            key={profile.id}
                            className={`
                group relative bg-white dark:bg-slate-800 rounded-2xl border-2 transition-all duration-300 hover:shadow-xl hover:-translate-y-1 overflow-hidden
                ${activeProfileId === profile.id
                                    ? 'border-emerald-500 shadow-lg shadow-emerald-500/10'
                                    : 'border-gray-100 dark:border-slate-700 hover:border-blue-500/50'}
              `}
                        >
                            {/* Color accent bar */}
                            <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${profile.color}, ${profile.color}88)` }} />

                            <div className="p-6">
                                <div className="flex items-start justify-between mb-4">
                                    <div className="flex items-center gap-3">
                                        <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shadow-sm"
                                            style={{ backgroundColor: profile.color + '15', border: `1px solid ${profile.color}30` }}>
                                            {profile.icon}
                                        </div>
                                        <div>
                                            <h3 className="font-bold text-gray-900 dark:text-white text-lg">{profile.name}</h3>
                                            <p className="text-xs text-gray-400 flex items-center gap-1 mt-0.5">
                                                <Clock className="w-3 h-3" />
                                                {new Date(profile.updatedAt).toLocaleDateString()}
                                            </p>
                                        </div>
                                    </div>
                                    {activeProfileId === profile.id && (
                                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                                            Active
                                        </span>
                                    )}
                                </div>

                                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 line-clamp-2 min-h-[2.5rem]">
                                    {profile.description || 'No description'}
                                </p>

                                {/* Quick stats */}
                                <div className="flex gap-3 mb-5">
                                    <div className="flex-1 p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                                        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                            <Wifi className="w-3 h-3" /> MQTT
                                        </div>
                                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mt-1 truncate">
                                            {profile.config.mqttBroker}:{profile.config.mqttPort}
                                        </p>
                                    </div>
                                    <div className="flex-1 p-2.5 rounded-lg bg-gray-50 dark:bg-slate-700/50">
                                        <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                                            <Settings className="w-3 h-3" /> Pipelines
                                        </div>
                                        <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mt-1">
                                            {getPipelineCount(profile.id)} created
                                        </p>
                                    </div>
                                </div>

                                {/* Actions */}
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setActiveProfile(profile.id)}
                                        disabled={activeProfileId === profile.id}
                                        className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-1.5
                      ${activeProfileId === profile.id
                                                ? 'bg-emerald-50 text-emerald-500 dark:bg-emerald-500/10 cursor-default'
                                                : 'bg-blue-50 hover:bg-blue-100 text-blue-600 dark:bg-blue-500/10 dark:hover:bg-blue-500/20 dark:text-blue-400'
                                            }
                    `}
                                    >
                                        {activeProfileId === profile.id ? (
                                            <><Check className="w-4 h-4" /> Active</>
                                        ) : (
                                            <><ChevronRight className="w-4 h-4" /> Activate</>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => navigate(`/profiles/${profile.id}`)}
                                        className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-400 hover:to-purple-400 text-white text-xs font-bold transition-all shadow-sm shadow-purple-500/20 shrink-0"
                                        title="Open Node Editor & Dashboard"
                                    >
                                        <ExternalLink className="w-3.5 h-3.5" /> Open
                                    </button>
                                    <button
                                        onClick={() => openEdit(profile)}
                                        className="p-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-500 dark:text-gray-400 transition-all"
                                        title="Edit"
                                    >
                                        <Edit3 className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => duplicateProfile(profile.id)}
                                        className="p-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-500 dark:text-gray-400 transition-all"
                                        title="Duplicate"
                                    >
                                        <Copy className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => setDeleteConfirmId(profile.id)}
                                        className="p-2.5 rounded-xl bg-gray-50 hover:bg-red-50 dark:bg-slate-700 dark:hover:bg-red-500/10 text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400 transition-all"
                                        title="Delete"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>

                            {/* Delete confirmation overlay */}
                            {deleteConfirmId === profile.id && (
                                <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-sm flex flex-col items-center justify-center p-6 z-10 rounded-2xl">
                                    <Trash2 className="w-10 h-10 text-red-400 mb-3" />
                                    <p className="text-white font-semibold mb-1">Delete this profile?</p>
                                    <p className="text-gray-400 text-sm mb-5 text-center">This action cannot be undone</p>
                                    <div className="flex gap-3">
                                        <button
                                            onClick={() => setDeleteConfirmId(null)}
                                            className="px-5 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-sm font-medium transition-all"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={() => { deleteProfile(profile.id); setDeleteConfirmId(null); }}
                                            className="px-5 py-2 rounded-xl bg-red-500 hover:bg-red-400 text-white text-sm font-medium transition-all"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* Create / Edit Modal */}
            {(showCreateModal || editingProfile) && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-slate-800 rounded-3xl border border-gray-200 dark:border-slate-700 p-8 max-w-lg w-full shadow-2xl">
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                                {editingProfile ? 'Edit Profile' : 'New Digital Twin Profile'}
                            </h3>
                            <button
                                onClick={() => { setShowCreateModal(false); setEditingProfile(null); resetForm(); }}
                                className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-slate-700 transition-all"
                            >
                                <X className="w-5 h-5 text-gray-500" />
                            </button>
                        </div>

                        <div className="space-y-5">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Profile Name</label>
                                <input
                                    id="profile-name-input"
                                    type="text"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all text-sm"
                                    placeholder="e.g. OC4 Production, Testing Environment..."
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Description</label>
                                <textarea
                                    id="profile-desc-input"
                                    value={newDesc}
                                    onChange={e => setNewDesc(e.target.value)}
                                    rows={3}
                                    className="w-full px-4 py-3 bg-gray-50 dark:bg-slate-900/50 border border-gray-200 dark:border-slate-600 rounded-xl text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all text-sm resize-none"
                                    placeholder="Describe this digital twin configuration..."
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Icon</label>
                                <div className="flex gap-2 flex-wrap">
                                    {PROFILE_ICONS.map(icon => (
                                        <button
                                            key={icon}
                                            onClick={() => setNewIcon(icon)}
                                            className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all ${newIcon === icon
                                                    ? 'bg-blue-100 dark:bg-blue-500/20 ring-2 ring-blue-500 scale-110'
                                                    : 'bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600'
                                                }`}
                                        >
                                            {icon}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Color</label>
                                <div className="flex gap-2 flex-wrap">
                                    {PROFILE_COLORS.map(color => (
                                        <button
                                            key={color}
                                            onClick={() => setNewColor(color)}
                                            className={`w-8 h-8 rounded-lg transition-all ${newColor === color ? 'ring-2 ring-offset-2 ring-blue-500 dark:ring-offset-slate-800 scale-110' : 'hover:scale-105'
                                                }`}
                                            style={{ backgroundColor: color }}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-3 mt-8">
                            <button
                                onClick={() => { setShowCreateModal(false); setEditingProfile(null); resetForm(); }}
                                className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-gray-700 dark:text-gray-300 font-medium transition-all text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                id="save-profile-btn"
                                onClick={editingProfile ? handleUpdate : handleCreate}
                                disabled={!newName.trim()}
                                className="flex-1 py-3 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-400 hover:to-cyan-400 text-white font-semibold transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                            >
                                {editingProfile ? 'Save Changes' : 'Create Profile'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
