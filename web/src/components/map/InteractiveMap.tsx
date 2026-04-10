import { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Search, Locate } from 'lucide-react';

// Fix for default marker icons in React Leaflet
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
    iconUrl: icon,
    shadowUrl: iconShadow,
    iconAnchor: [12, 41],
});

L.Marker.prototype.options.icon = DefaultIcon;

interface POI {
  id: string;
  position: [number, number];
  title: string;
  description: string;
}

interface MapProps {
  pois?: POI[];
  center?: [number, number];
  zoom?: number;
  children?: React.ReactNode;
}

function MapController({ center }: { center: [number, number] }) {
  const map = useMap();
  const isInteracting = useRef(false);
  const previousCenter = useRef(center);

  useMapEvents({
    dragstart: () => {
      isInteracting.current = true;
    },
    dragend: () => {
      // Small delay to prevent immediate snap-back if updates are frequent
      setTimeout(() => {
        isInteracting.current = false;
      }, 1000);
    },
    zoomstart: () => {
      isInteracting.current = true;
    },
    zoomend: () => {
      setTimeout(() => {
        isInteracting.current = false;
      }, 1000);
    },
  });

  useEffect(() => {
    // If user is interacting, do NOT update view automatically
    if (isInteracting.current) return;

    // Calculate distance to determine if we should fly or pan
    // Using simple Euclidean distance approx for speed (valid for small local areas)
    const dist = Math.sqrt(
      Math.pow(center[0] - previousCenter.current[0], 2) + 
      Math.pow(center[1] - previousCenter.current[1], 2)
    );

    // Threshold for "Jump" vs "Track" (approx 0.001 degrees is ~100m)
    // If distance is large (>0.0005), use flyTo (animation)
    // If distance is small (tracking), use panTo (smoother) or setView
    // If distance is 0, do nothing
    
    if (dist > 0.0005) {
        map.flyTo(center, map.getZoom());
    } else if (dist > 0) {
        // For small tracking updates, panTo is better
        map.panTo(center, { animate: true, duration: 0.5 });
    }

    previousCenter.current = center;
  }, [center, map]);

  return null;
}

export default function InteractiveMap({ pois = [], center = [41.3851, 2.1734], zoom = 13, children }: MapProps) {
  const [mapCenter, setMapCenter] = useState<[number, number]>(center);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [userLocation, setUserLocation] = useState<[number, number] | null>(null);

  // Sync internal map center state with prop updates (e.g. for tracking)
  useEffect(() => {
    setMapCenter(center);
  }, [center]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}`
      );
      const data = await response.json();
      if (data && data.length > 0) {
        const { lat, lon } = data[0];
        setMapCenter([parseFloat(lat), parseFloat(lon)]);
      }
    } catch (error) {
      console.error('Error searching address:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const LocationButton = () => {
    const map = useMap();
    
    const locateUser = () => {
      map.locate().on("locationfound", function (e) {
        setUserLocation([e.latlng.lat, e.latlng.lng]);
        map.flyTo(e.latlng, 16);
      });
    };

    return (
      <div className="leaflet-bottom leaflet-right" style={{ marginBottom: '80px', marginRight: '10px', pointerEvents: 'auto' }}>
        <button
          onClick={(e) => {
             e.stopPropagation();
             locateUser();
          }}
          className="bg-white p-2 rounded-lg shadow-md hover:bg-gray-50 border border-gray-300 flex items-center justify-center w-10 h-10"
          title="Locate Me"
        >
          <Locate className="w-5 h-5 text-blue-600" />
        </button>
      </div>
    );
  };

  return (
    <div className="relative w-full h-full rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-slate-700">
      {/* Search Bar Overlay */}
      <div className="absolute top-4 left-4 z-[1000] w-full max-w-sm">
        <form onSubmit={handleSearch} className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search location..."
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 shadow-md focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white dark:bg-slate-800 dark:border-slate-600 dark:text-white"
          />
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
          <button
            type="submit"
            disabled={isSearching}
            className="absolute right-2 top-1.5 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {isSearching ? '...' : 'Go'}
          </button>
        </form>
      </div>

      <MapContainer
        center={center}
        zoom={zoom}
        scrollWheelZoom={true}
        className="w-full h-full"
        style={{ minHeight: '500px' }}
      >
        <TileLayer
          maxZoom={19}
          attribution='Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        />
        
        <MapController center={mapCenter} />
        
        {/* User Location Marker */}
        {userLocation && (
          <Marker position={userLocation}>
            <Popup>You are here</Popup>
          </Marker>
        )}

        {/* POI Markers */}
        {pois.map((poi) => (
          <Marker key={poi.id} position={poi.position}>
            <Popup>
              <div className="p-1">
                <h3 className="font-bold text-sm">{poi.title}</h3>
                <p className="text-xs text-gray-600">{poi.description}</p>
              </div>
            </Popup>
          </Marker>
        ))}
        
        {children}

        <LocationButton />
      </MapContainer>
    </div>
  );
}
