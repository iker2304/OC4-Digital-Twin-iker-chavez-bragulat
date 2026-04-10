export default function Grafana() {
  return (
    <div className="flex flex-col h-full">
      <h2 className="text-lg font-medium mb-3 text-gray-700 dark:text-gray-300">Grafana Analytics</h2>
      <div className="flex-1 bg-white rounded-lg overflow-hidden border border-gray-200 min-h-[600px] dark:bg-gray-800 dark:border-gray-700">
        <iframe
          src="http://localhost:3000/d/oc4-dashboard/oc4-overview?orgId=1&kiosk"
          className="w-full h-full"
          frameBorder="0"
          title="Grafana Dashboard"
        ></iframe>
      </div>
    </div>
  );
}
