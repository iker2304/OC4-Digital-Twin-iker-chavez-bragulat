import { Card, PageHeader } from '../components/ui';

export default function Grafana() {
  return (
    <div className="flex flex-col h-full space-y-4">
      <PageHeader
        eyebrow="Observabilidad"
        title="Grafana Analytics"
        description="Panel embebido de series temporales y métricas operativas."
      />
      <Card className="flex-1 overflow-hidden min-h-[600px]">
        <iframe
          src="http://localhost:3000/d/oc4-dashboard/oc4-overview?orgId=1&kiosk"
          className="w-full h-full border-0"
          title="Grafana Dashboard"
        />
      </Card>
    </div>
  );
}
