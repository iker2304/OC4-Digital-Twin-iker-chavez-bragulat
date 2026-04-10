import { useState, useEffect } from 'react';

type DatasetStats = {
  train_count: number;
  val_count: number;
  total_count: number;
};

export default function DatasetViewer({ onClose }: { onClose: () => void }) {
  const [subset, setSubset] = useState<'train' | 'val'>('train');
  const [images, setImages] = useState<string[]>([]);
  const [stats, setStats] = useState<DatasetStats | null>(null);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [labelContent, setLabelContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('http://localhost:8080/dataset/stats')
      .then((res) => res.json())
      .then((data) => setStats(data))
      .catch(console.error);
  }, []);

  useEffect(() => {
    setLoading(true);
    fetch(`http://localhost:8080/dataset/images/${subset}`)
      .then((res) => res.json())
      .then((data) => {
        setImages(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setLoading(false);
      });
  }, [subset]);

  useEffect(() => {
    if (selectedImage) {
      fetch(`http://localhost:8080/dataset/file/${subset}/labels/${selectedImage}`)
        .then((res) => res.json())
        .then((data) => setLabelContent(data.content))
        .catch(console.error);
    } else {
      setLabelContent('');
    }
  }, [selectedImage, subset]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex justify-between items-center bg-gray-50 dark:bg-slate-900">
          <h2 className="text-xl font-bold dark:text-white flex items-center gap-2">
            📂 Explorador de Dataset
            <span className="text-sm font-normal text-gray-500 dark:text-slate-400 ml-2">
                (c:\...\data\synthetic_dataset\dataset)
            </span>
          </h2>
          <div className="flex gap-4 items-center">
             <div className="text-sm text-gray-600 dark:text-slate-300 bg-white dark:bg-slate-800 px-3 py-1 rounded border border-gray-200 dark:border-slate-700">
                Total: <b>{stats?.total_count || 0}</b> (Train: {stats?.train_count}, Val: {stats?.val_count})
             </div>
             <button 
                onClick={onClose} 
                className="text-gray-500 hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400 transition-colors p-1"
             >
               <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
               </svg>
             </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
            {/* Sidebar / Grid */}
            <div className={`flex-1 flex flex-col transition-all duration-300 ${selectedImage ? 'w-2/3' : 'w-full'}`}>
                <div className="p-4 flex gap-2 border-b border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800">
                    <button 
                        onClick={() => { setSubset('train'); setSelectedImage(null); }}
                        className={`px-4 py-2 rounded text-sm font-medium transition-colors ${subset === 'train' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                    >
                        Train ({stats?.train_count || 0})
                    </button>
                    <button 
                        onClick={() => { setSubset('val'); setSelectedImage(null); }}
                        className={`px-4 py-2 rounded text-sm font-medium transition-colors ${subset === 'val' ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'}`}
                    >
                        Val ({stats?.val_count || 0})
                    </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-slate-900/50">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                            {images.map(img => (
                                <div 
                                    key={img} 
                                    onClick={() => setSelectedImage(img)}
                                    className={`group cursor-pointer border-2 rounded-lg overflow-hidden transition-all hover:shadow-lg ${selectedImage === img ? 'border-blue-600 ring-2 ring-blue-300 scale-105 z-10' : 'border-transparent hover:border-gray-300 dark:hover:border-slate-600'}`}
                                >
                                    <div className="aspect-square bg-gray-200 dark:bg-slate-800 relative">
                                        <img 
                                            src={`http://localhost:8080/dataset/file/${subset}/images/${img}`} 
                                            alt={img}
                                            className="object-cover w-full h-full"
                                            loading="lazy"
                                        />
                                        <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all" />
                                    </div>
                                    <div className="p-2 text-xs truncate text-center bg-white dark:bg-slate-800 dark:text-slate-300 font-mono">
                                        {img}
                                    </div>
                                </div>
                            ))}
                            {images.length === 0 && (
                                <div className="col-span-full text-center py-10 text-gray-500">
                                    No se encontraron imágenes en esta carpeta.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Detail View */}
            {selectedImage && (
                <div className="w-96 border-l border-gray-200 dark:border-slate-700 flex flex-col bg-white dark:bg-slate-800 shadow-xl z-20">
                    <div className="p-4 border-b border-gray-200 dark:border-slate-700 flex justify-between items-center bg-gray-50 dark:bg-slate-900">
                        <h3 className="font-bold truncate text-sm" title={selectedImage}>{selectedImage}</h3>
                        <button onClick={() => setSelectedImage(null)} className="text-gray-500 hover:text-gray-700">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-4">
                        <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700 bg-black flex items-center justify-center min-h-[200px]">
                             <img 
                                src={`http://localhost:8080/dataset/file/${subset}/images/${selectedImage}`} 
                                alt={selectedImage}
                                className="max-w-full max-h-[300px] object-contain"
                            />
                        </div>
                        
                        <div className="space-y-2">
                            <h4 className="font-semibold text-xs uppercase text-gray-500 tracking-wider">Etiqueta (YOLO)</h4>
                            <div className="relative">
                                <pre className="bg-gray-50 dark:bg-slate-900 p-3 rounded border border-gray-200 dark:border-slate-700 text-xs overflow-x-auto whitespace-pre-wrap font-mono h-48">
                                    {labelContent || "Sin contenido o cargando..."}
                                </pre>
                            </div>
                        </div>

                        <div className="text-xs text-gray-500 dark:text-slate-400">
                            <p>Ruta: .../dataset/{subset}/images/{selectedImage}</p>
                            <p className="mt-1">Ruta Label: .../dataset/{subset}/labels/{selectedImage?.replace('.png', '.txt')}</p>
                        </div>
                    </div>
                </div>
            )}
        </div>
      </div>
    </div>
  );
}
