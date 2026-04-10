import { useState, useEffect, useMemo } from 'react';
import InteractiveMap from '../components/map/InteractiveMap';
import { Navigation, Plus, Save, Edit2, Trash2 } from 'lucide-react';
import { useMap, useMapEvents, Marker, Popup, Circle, CircleMarker } from 'react-leaflet';

import { useTwinStore } from '../store/twinStore';
import SidePanel from '../components/map/SidePanel';
import DriftTrail from '../components/map/DriftTrail';
import type { POI, WeatherData } from '../types';

// Target Coordinates: 41°21'46.8"N 2°11'12.7"E -> 41.363000, 2.1868611
const ORIGIN_COORDS: [number, number] = [41.363000, 2.1868611];
// Amplification factor to make movement visible on map (exaggerated for demo)
const MOVEMENT_SCALE = 0.01;

// Component to handle map resize when layout changes
const MapResizer = ({ activePoi }: { activePoi: string | null }) => {
  const map = useMap();

  useEffect(() => {
    // Wait for the transition (700ms) to finish, then invalidate size once
    const timer = setTimeout(() => map.invalidateSize(), 750);
    return () => clearTimeout(timer);
  }, [activePoi, map]);

  return null;
};

// Custom hook for weather data with 5s update interval
const useWeather = () => {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const { setEnvConditions } = useTwinStore();

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        // Fetch from Open-Meteo
        const response = await fetch(
          `https://marine-api.open-meteo.com/v1/marine?latitude=${ORIGIN_COORDS[0]}&longitude=${ORIGIN_COORDS[1]}&current=wave_height,wave_direction,wave_period&hourly=wave_height&daily=wave_height_max`
        );
        const marineData = await response.json();

        const responseWeather = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${ORIGIN_COORDS[0]}&longitude=${ORIGIN_COORDS[1]}&current=temperature_2m,wind_speed_10m,wind_direction_10m,visibility`
        );
        const weatherData = await responseWeather.json();

        const newWeather = {
          temp: weatherData.current?.temperature_2m,
          windSpeed: weatherData.current?.wind_speed_10m,
          windDir: weatherData.current?.wind_direction_10m,
          visibility: weatherData.current?.visibility,
          waveHeight: marineData.current?.wave_height,
          wavePeriod: marineData.current?.wave_period,
          waveDir: marineData.current?.wave_direction
        };

        setWeather(newWeather);

        // Update Physics Engine Environment
        setEnvConditions({
          windSpeed: newWeather.windSpeed ? newWeather.windSpeed / 3.6 : 12, // Convert km/h to m/s
          waveHeight: newWeather.waveHeight || 2.5,
          currentSpeed: 0.5 // Default or fetch if available
        });

      } catch (e) {
        console.error("Failed to fetch weather", e);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 300000); // 5 minutes instead of 5 seconds
    return () => clearInterval(interval);
  }, [setEnvConditions]);

  return weather;
};

// Component to handle map clicks for adding POIs
function MapEvents({ isEditing, onMapClick }: { isEditing: boolean, onMapClick: (latlng: [number, number]) => void }) {
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
  // Only subscribe to history and navigation here. Structural data is in SidePanel.
  const { history, navigation, connect, isConnected } = useTwinStore();
  const weather = useWeather();

  useEffect(() => {
    connect();
  }, [connect]);

  const [activePoi, setActivePoi] = useState<string | null>(null);

  // POI Management State
  const [pois, setPois] = useState<POI[]>([
    {
      id: 'oc4-platform',
      position: [41.363000, 2.1868611], // Exact mathematical translation
      title: 'OC4 Platform',
      description: 'Offshore Floating Wind Turbine Prototype',
      isRemovable: false
    }
  ]);
  const [isEditing, setIsEditing] = useState(false);
  const [newPoi, setNewPoi] = useState<{ id?: string, position: [number, number], title: string, desc: string } | null>(null);

  const currentOc4Position = useMemo<[number, number]>(() => {
    const latOffset = (navigation.position.x * MOVEMENT_SCALE) / 111111;
    const lonOffset = (navigation.position.z * MOVEMENT_SCALE) / (111111 * Math.cos(ORIGIN_COORDS[0] * Math.PI / 180));

    const newPos: [number, number] = [ORIGIN_COORDS[0] + latOffset, ORIGIN_COORDS[1] + lonOffset];
    return newPos;
  }, [navigation.position]);

  const driftPath = useMemo(() => {
    return history.x.slice(-100).map((pos, i) => {
      const zVal = history.z[history.z.length - history.x.length + i]?.value || 0;
      const latOffset = (pos.value * MOVEMENT_SCALE) / 111111;
      const lonOffset = (zVal * MOVEMENT_SCALE) / (111111 * Math.cos(ORIGIN_COORDS[0] * Math.PI / 180));
      return [ORIGIN_COORDS[0] + latOffset, ORIGIN_COORDS[1] + lonOffset] as [number, number];
    });
  }, [history.x, history.z]);

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
        setPois(pois.map(p => p.id === newPoi.id ? { ...p, title: newPoi.title, description: newPoi.desc } : p));
      } else {
        setPois([...pois, {
          id: `poi-${Date.now()}`,
          position: newPoi.position,
          title: newPoi.title,
          description: newPoi.desc,
          isRemovable: true
        }]);
      }
      setNewPoi(null);
      setIsEditing(false);
    }
  };

  const deletePoi = (id: string) => {
    setPois(pois.filter(p => p.id !== id));
    if (activePoi === id) setActivePoi(null);
  };

  return (
    <div className="w-full h-screen relative bg-gray-50 dark:bg-slate-900 overflow-hidden flex flex-col">
      {/* Top Header Bar */}
      <div className="h-12 bg-white dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 flex items-center px-4 z-[1200] shrink-0 shadow-sm">
        <h1 className="text-sm font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Navigation className="w-4 h-4 text-blue-600" />
          OC4 Digital Twin Map
        </h1>
        <div className="ml-auto flex items-center gap-3 text-xs text-gray-500">
          <span>{isConnected ? "System Online" : "System Offline"}</span>
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
        </div>
      </div>

      <div className="flex-1 relative flex overflow-hidden">
        {/* Main Map Area */}
        <div className={`relative h-full transition-all duration-700 ease-[cubic-bezier(0.25,0.1,0.25,1)] ${activePoi ? 'w-[calc(100%-480px)]' : 'w-full'} z-0`}>
          <div className="absolute top-4 right-4 z-[1000] flex gap-2">
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg shadow-lg transition-colors ${isEditing ? 'bg-green-600 text-white' : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 dark:bg-slate-800 dark:text-white dark:border-slate-600'}`}
            >
              {isEditing ? <Save className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
              {isEditing ? 'Done' : 'Add POI'}
            </button>
          </div>

          <InteractiveMap
            pois={[]}
            center={activePoi === 'oc4-platform' ? currentOc4Position : ORIGIN_COORDS}
            zoom={activePoi === 'oc4-platform' ? 17 : 14}
          >
            <MapResizer activePoi={activePoi} />
            <MapEvents isEditing={isEditing} onMapClick={handleAddClick} />

            {pois.filter(p => p.id !== 'oc4-platform').map(poi => (
              <Marker key={poi.id} position={poi.position} eventHandlers={{ click: () => handlePoiClick(poi.id) }}>
                <Popup>
                  <div className="p-1 min-w-[150px]">
                    <h3 className="font-bold text-sm">{poi.title}</h3>
                    <p className="text-xs text-gray-600 mb-2">{poi.description}</p>
                    {poi.isRemovable && (
                      <div className="flex gap-2 border-t pt-2 mt-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleEditClick(poi); }}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:bg-blue-50 p-1 rounded"
                        >
                          <Edit2 className="w-3 h-3" /> Edit
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); deletePoi(poi.id); }}
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

            <Marker
              position={currentOc4Position}
              eventHandlers={{ click: () => handlePoiClick('oc4-platform') }}
            >
              <Popup>
                <div className="p-1">
                  <h3 className="font-bold text-sm">OC4 Platform (Live)</h3>
                  <p className="text-xs text-gray-600">Real-time Position</p>
                </div>
              </Popup>
            </Marker>

            <DriftTrail path={driftPath} />
            <Circle center={currentOc4Position} radius={50} pathOptions={{ color: 'blue', fillColor: 'blue', fillOpacity: 0.05 }} />

            <CircleMarker
              center={currentOc4Position}
              radius={20}
              pathOptions={{ opacity: 0, fillOpacity: 0 }}
              eventHandlers={{ click: () => handlePoiClick('oc4-platform') }}
            />

          </InteractiveMap>

          {/* New POI Modal */}
          {newPoi && (
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white dark:bg-slate-900 p-4 rounded-lg shadow-2xl border border-gray-200 z-[2000] w-80">
              <h3 className="font-bold mb-2">{newPoi.id ? 'Edit Point' : 'Add New Point'}</h3>
              <input
                className="w-full mb-2 p-2 border rounded dark:bg-slate-800 dark:border-slate-600"
                placeholder="Title"
                value={newPoi.title}
                onChange={e => setNewPoi({ ...newPoi, title: e.target.value })}
              />
              <textarea
                className="w-full mb-4 p-2 border rounded dark:bg-slate-800 dark:border-slate-600"
                placeholder="Description"
                value={newPoi.desc}
                onChange={e => setNewPoi({ ...newPoi, desc: e.target.value })}
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setNewPoi(null)} className="px-3 py-1 text-gray-600 dark:text-gray-400">Cancel</button>
                <button onClick={confirmAddPoi} className="px-3 py-1 bg-blue-600 text-white rounded">Save</button>
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
