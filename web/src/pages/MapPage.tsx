import { useState, useEffect, useMemo } from 'react';
import InteractiveMap from '../components/map/InteractiveMap';
import { Navigation, Plus, Save, Edit2, Trash2 } from 'lucide-react';
import { useMap, useMapEvents, Marker, Popup, Circle, CircleMarker } from 'react-leaflet';

import { useTwinStore } from '../store/twinStore';
import { useProfileStore } from '../store/profileStore';
import SidePanel from '../components/map/SidePanel';
import DriftTrail from '../components/map/DriftTrail';
import type { POI, WeatherData } from '../types';
import { Glyph } from '../components/ui/Glyph';
import { Button, StatusDot } from '../components/ui';

// Default Target Coordinates: 41°21'46.8"N 2°11'12.7"E -> 41.363000, 2.1868611
const DEFAULT_ORIGIN_COORDS: [number, number] = [41.363000, 2.1868611];
const MOVEMENT_SCALE = 0.01;

const MapResizer = ({ activePoi }: { activePoi: string | null }) => {
  const map = useMap();

  useEffect(() => {
    const timer = setTimeout(() => map.invalidateSize(), 750);
    return () => clearTimeout(timer);
  }, [activePoi, map]);

  return null;
};

const useWeather = (coords: [number, number]) => {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const { setEnvConditions } = useTwinStore();

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const response = await fetch(
          `https://marine-api.open-meteo.com/v1/marine?latitude=${coords[0]}&longitude=${coords[1]}&current=wave_height,wave_direction,wave_period&hourly=wave_height&daily=wave_height_max`
        );
        const marineData = await response.json();

        const responseWeather = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&current=temperature_2m,wind_speed_10m,wind_direction_10m,visibility`
        );
        const weatherData = await responseWeather.json();

        const newWeather = {
          temp: weatherData.current?.temperature_2m,
          windSpeed: weatherData.current?.wind_speed_10m,
          windDir: weatherData.current?.wind_direction_10m,
          visibility: weatherData.current?.visibility,
          waveHeight: marineData.current?.wave_height,
          wavePeriod: marineData.current?.wave_period,
          waveDir: marineData.current?.wave_direction,
        };

        setWeather(newWeather);

        setEnvConditions({
          windSpeed: newWeather.windSpeed ? newWeather.windSpeed / 3.6 : 12,
          waveHeight: newWeather.waveHeight || 2.5,
          currentSpeed: 0.5,
        });
      } catch (e) {
        console.error('Failed to fetch weather', e);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 300000);
    return () => clearInterval(interval);
  }, [setEnvConditions, coords[0], coords[1]]);

  return weather;
};

function MapEvents({ isEditing, onMapClick }: { isEditing: boolean; onMapClick: (latlng: [number, number]) => void }) {
  useMapEvents({
    click(e) {
      if (isEditing) {
        onMapClick([e.latlng.lat, e.latlng.lng]);
      }
    },
  });
  return null;
}

export default function MapPage() {
  const { history, navigation, connect, isConnected } = useTwinStore();
  const activeProfile = useProfileStore((s) => s.getActiveProfile());
  const originCoords: [number, number] = activeProfile?.config?.coordinates || DEFAULT_ORIGIN_COORDS;
  const weather = useWeather(originCoords);

  useEffect(() => {
    connect();
  }, [connect]);

  const [activePoi, setActivePoi] = useState<string | null>(null);

  const [pois, setPois] = useState<POI[]>([
    {
      id: 'oc4-platform',
      position: originCoords,
      title: activeProfile?.name || 'OC4 Platform',
      description: activeProfile?.description || 'Offshore Floating Wind Turbine Prototype',
      isRemovable: false,
    },
  ]);
  const [isEditing, setIsEditing] = useState(false);
  const [newPoi, setNewPoi] = useState<{ id?: string; position: [number, number]; title: string; desc: string } | null>(null);

  const currentOc4Position = useMemo<[number, number]>(() => {
    const latOffset = (navigation.position.x * MOVEMENT_SCALE) / 111111;
    const lonOffset = (navigation.position.z * MOVEMENT_SCALE) / (111111 * Math.cos((originCoords[0] * Math.PI) / 180));

    const newPos: [number, number] = [originCoords[0] + latOffset, originCoords[1] + lonOffset];
    return newPos;
  }, [navigation.position, originCoords]);

  const driftPath = useMemo(() => {
    return history.x.slice(-100).map((pos, i) => {
      const zVal = history.z[history.z.length - history.x.length + i]?.value || 0;
      const latOffset = (pos.value * MOVEMENT_SCALE) / 111111;
      const lonOffset = (zVal * MOVEMENT_SCALE) / (111111 * Math.cos((originCoords[0] * Math.PI) / 180));
      return [originCoords[0] + latOffset, originCoords[1] + lonOffset] as [number, number];
    });
  }, [history.x, history.z, originCoords]);

  const handlePoiClick = (id: string) => {
    setActivePoi(id === activePoi ? null : id);
  };

  const handleAddClick = (latlng: [number, number]) => {
    setNewPoi({ position: latlng, title: 'New Point', desc: 'Description' });
  };

  const handleEditClick = (poi: POI) => {
    setNewPoi({ id: poi.id, position: poi.position, title: poi.title, desc: poi.description });
  };

  const confirmAddPoi = () => {
    if (newPoi) {
      if (newPoi.id) {
        setPois(pois.map((p) => (p.id === newPoi.id ? { ...p, title: newPoi.title, description: newPoi.desc } : p)));
      } else {
        setPois([
          ...pois,
          {
            id: `poi-${Date.now()}`,
            position: newPoi.position,
            title: newPoi.title,
            description: newPoi.desc,
            isRemovable: true,
          },
        ]);
      }
      setNewPoi(null);
      setIsEditing(false);
    }
  };

  const deletePoi = (id: string) => {
    setPois(pois.filter((p) => p.id !== id));
    if (activePoi === id) setActivePoi(null);
  };

  return (
    <div className="w-full h-full relative bg-gray-50 dark:bg-slate-900 overflow-hidden flex flex-col">
      {/* Top Header Bar */}
      <div className="h-11 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 flex items-center px-4 z-[1200] shrink-0">
        <h1 className="text-xs font-semibold text-gray-900 dark:text-white flex items-center gap-2">
          {activeProfile ? (
            <Glyph name={activeProfile.icon} className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          ) : (
            <Navigation className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          )}
          <span>
            {activeProfile
              ? `${activeProfile.name} — ${activeProfile.config.locationName}`
              : 'Digital Twin Geospatial Map'}
          </span>
        </h1>
        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          <StatusDot status={isConnected ? 'online' : 'offline'} />
          <span>{isConnected ? 'Sistema conectado' : 'Sin conexión'}</span>
        </div>
      </div>

      <div className="flex-1 relative flex overflow-hidden">
        {/* Main Map Area */}
        <div
          className={`relative h-full transition-all duration-500 ease-out ${
            activePoi ? 'w-[calc(100%-480px)]' : 'w-full'
          } z-0`}
        >
          <div className="absolute top-4 right-4 z-[1000] flex gap-2">
            <Button
              variant={isEditing ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setIsEditing(!isEditing)}
              className="bg-white dark:bg-slate-900 shadow-sm"
            >
              {isEditing ? <Save className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
              {isEditing ? 'Finalizar edición' : 'Añadir POI'}
            </Button>
          </div>

          <InteractiveMap
            pois={[]}
            center={activePoi === 'oc4-platform' ? currentOc4Position : originCoords}
            zoom={activePoi === 'oc4-platform' ? 17 : 14}
          >
            <MapResizer activePoi={activePoi} />
            <MapEvents isEditing={isEditing} onMapClick={handleAddClick} />

            {pois
              .filter((p) => p.id !== 'oc4-platform')
              .map((poi) => (
                <Marker key={poi.id} position={poi.position} eventHandlers={{ click: () => handlePoiClick(poi.id) }}>
                  <Popup>
                    <div className="p-1 min-w-[150px]">
                      <h3 className="font-semibold text-sm">{poi.title}</h3>
                      <p className="text-xs text-gray-600 mb-2">{poi.description}</p>
                      {poi.isRemovable && (
                        <div className="flex gap-2 border-t pt-2 mt-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEditClick(poi);
                            }}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:bg-blue-50 p-1 rounded"
                          >
                            <Edit2 className="w-3 h-3" /> Edit
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePoi(poi.id);
                            }}
                            className="flex items-center gap-1 text-xs text-red-600 hover:bg-red-50 p-1 rounded"
                          >
                            <Trash2 className="w-3 h-3" /> Del
                          </button>
                        </div>
                      )}
                    </div>
                  </Popup>
                </Marker>
              ))}

            <Marker position={currentOc4Position} eventHandlers={{ click: () => handlePoiClick('oc4-platform') }}>
              <Popup>
                <div className="p-1">
                  <h3 className="font-semibold text-sm">{activeProfile?.name || 'OC4 Platform'} (Live)</h3>
                  <p className="text-xs text-gray-600">{activeProfile?.config?.locationName || 'Real-time Position'}</p>
                </div>
              </Popup>
            </Marker>

            <DriftTrail path={driftPath} />
            <Circle
              center={currentOc4Position}
              radius={50}
              pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08 }}
            />

            <CircleMarker
              center={currentOc4Position}
              radius={20}
              pathOptions={{ opacity: 0, fillOpacity: 0 }}
              eventHandlers={{ click: () => handlePoiClick('oc4-platform') }}
            />
          </InteractiveMap>

          {/* New POI Modal */}
          {newPoi && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-slate-900 p-4 rounded-xl shadow-lg border border-gray-200 dark:border-slate-800 z-[2000] w-80 space-y-3">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                {newPoi.id ? 'Editar punto de interés' : 'Nuevo punto de interés'}
              </h3>
              <div>
                <label className="ui-label">Título</label>
                <input
                  className="ui-input"
                  placeholder="Title"
                  value={newPoi.title}
                  onChange={(e) => setNewPoi({ ...newPoi, title: e.target.value })}
                />
              </div>
              <div>
                <label className="ui-label">Descripción</label>
                <textarea
                  className="ui-input"
                  placeholder="Description"
                  value={newPoi.desc}
                  onChange={(e) => setNewPoi({ ...newPoi, desc: e.target.value })}
                />
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <Button variant="ghost" size="sm" onClick={() => setNewPoi(null)}>
                  Cancelar
                </Button>
                <Button variant="primary" size="sm" onClick={confirmAddPoi}>
                  Guardar
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Side Detail Panel */}
        <SidePanel
          activePoi={activePoi}
          pois={pois}
          weather={weather}
          onClose={() => setActivePoi(null)}
        />
      </div>
    </div>
  );
}
