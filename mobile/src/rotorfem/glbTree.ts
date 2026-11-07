/**
 * Árbol de nodos del `.glb`, para poder elegir el anclaje mirando el modelo.
 *
 * El gemelo del proyecto tiene 327 nodos y nombres que repiten sufijo de Blender
 * (`Blade_red v1:1`, `Pilar_base v9:2`…), así que se agrupan por **prefijo** para
 * que la lista se pueda leer: los `:1`, `:2` y `.001` de la misma pieza caen en
 * la misma rama.
 *
 * La clasificación es deliberadamente simple y explícita: es rotor lo que cuelga
 * del nodo `rotate` (el grupo que gira) o se llama `Blade…` / `Hub…`; el resto es
 * plataforma. Si el `.glb` cambia de nombres, se ve al instante en la lista.
 */
import * as THREE from 'three';

export type NodeKind = 'rotor' | 'plataforma';

export interface TreeNode {
    /** Nombre completo del nodo (el del `.glb`). */
    name: string;
    kind: NodeKind;
    /** Número de mallas por debajo, incluida la propia. */
    meshCount: number;
    /** Centro del *bounding box* en coordenadas de mundo, si tiene geometría. */
    centre: [number, number, number] | null;
    children: TreeNode[];
}

const ROTOR_PATTERN = /rotat|blade|hub/i;

/** Quita los sufijos de instancia de Blender: `v1:2`, `.001`, `(1)`. */
function baseName(name: string): string {
    return name
        .replace(/\s*v\d+.*$/i, '')
        .replace(/\.\d{3}$/, '')
        .replace(/\s*\(\d+\)\s*$/, '')
        .replace(/:.*$/, '')
        .trim();
}

function countMeshes(object: THREE.Object3D): number {
    let total = 0;
    object.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) total += 1;
    });
    return total;
}

export function buildTree(root: THREE.Object3D): TreeNode {
    const box = new THREE.Box3();
    const centre = new THREE.Vector3();

    const visit = (object: THREE.Object3D, inheritedKind: NodeKind, isRoot: boolean): TreeNode => {
        const kind: NodeKind =
            inheritedKind === 'rotor' || ROTOR_PATTERN.test(object.name) ? 'rotor' : 'plataforma';

        // Un grupo vacío da una caja infinita: solo se usa si tiene geometría.
        let position: [number, number, number] | null = null;
        if (countMeshes(object) > 0) {
            box.setFromObject(object);
            if (!box.isEmpty()) {
                box.getCenter(centre);
                position = [centre.x, centre.y, centre.z];
            }
        }

        const children = isRoot
            ? // Los hijos directos de la escena se agrupan por pieza, no por instancia.
              groupChildren(object, kind)
            : object.children.map((child) => visit(child, kind, false));

        return {
            name: isRoot ? 'modelo' : object.name || '(sin nombre)',
            kind,
            meshCount: countMeshes(object),
            centre: position,
            children: children.filter((child) => child.meshCount > 0 || child.children.length > 0),
        };
    };

    return visit(root, 'plataforma', true);

    /**
     * Agrupa los hijos de la raíz por nombre base, sumando sus mallas y el centro
     * de su caja combinada. Es lo que convierte 327 filas en ~20 legibles.
     */
    function groupChildren(parent: THREE.Object3D, parentKind: NodeKind): TreeNode[] {
        const groups = new Map<string, { nodes: THREE.Object3D[] }>();
        for (const child of parent.children) {
            const key = baseName(child.name) || '(sin nombre)';
            const bucket = groups.get(key);
            if (bucket) bucket.nodes.push(child);
            else groups.set(key, { nodes: [child] });
        }

        const result: TreeNode[] = [];
        for (const [name, { nodes }] of groups) {
            const kind: NodeKind =
                parentKind === 'rotor' || ROTOR_PATTERN.test(name) ? 'rotor' : 'plataforma';

            const combined = new THREE.Box3();
            for (const node of nodes) combined.union(box.setFromObject(node));

            let position: [number, number, number] | null = null;
            if (!combined.isEmpty()) {
                combined.getCenter(centre);
                position = [centre.x, centre.y, centre.z];
            }

            const meshCount = nodes.reduce((sum, node) => sum + countMeshes(node), 0);
            result.push({
                name: nodes.length > 1 ? `${name} ×${nodes.length}` : name,
                kind,
                meshCount,
                centre: position,
                // Un nivel más de detalle sí se despliega: son pocos y con nombre propio.
                children: nodes.flatMap((node) =>
                    node.children.map((child) => visit(child, kind, false))
                ),
            });
        }
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }
}
