/* =========================================================
   INLOTRANS
   Indicadores sobre el tablero 3D

   ResumenMuelles   cifras sueltas (no son gráfico: cuatro
                    números se leen mejor como números)
   AvancePorMuelle  barras horizontales, una por muelle, con el
                    color de la fase y el % escrito al lado

   El registro de actividad no está aquí: cada panel ya tiene el
   suyo (shared/components/registroActividad.js).
   ========================================================= */

import { useState } from "react";
import { motion } from "motion/react";
import { IconAlertTriangle, IconChevronDown, IconParking } from "@tabler/icons-react";

import { COLOR_FASE, COLOR_NIVEL } from "../3d/TableroMuelles3D.jsx";

const vidrio = "rounded-2xl border border-borde bg-panel/88 shadow-xl backdrop-blur";


export function ResumenMuelles({ muelles, enPatio = null, compacto }) {

    const ocupados = muelles.filter((m) => m.vehiculo);
    const contar = (fase) => ocupados.filter((m) => m.vehiculo.fase === fase).length;
    const fueraDeMeta = ocupados.filter((m) => {
        const n = m.vehiculo.nivelTiempo(m.minutos);
        return n === "atencion" || n === "urgente";
    }).length;

    const cifras = [
        { titulo: "Ocupados", valor: `${ocupados.length}/${muelles.length}` },
        ...(enPatio === null ? [] : [{ titulo: "En patio", valor: enPatio }]),
        { titulo: "Descargue", valor: contar("Descargue"), color: COLOR_FASE.Descargue },
        { titulo: "Cargue", valor: contar("Cargue"), color: COLOR_FASE.Cargue },
        { titulo: "Fuera de meta", valor: fueraDeMeta, alerta: fueraDeMeta > 0 }
    ];

    return (
        <div className={`${vidrio} flex divide-x divide-borde ${compacto ? "text-xs" : ""}`}>
            {cifras.map((c) => (
                <div key={c.titulo} className={compacto ? "px-3 py-2" : "px-4 py-3"}>
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-texto-suave">
                        {c.color && <span className="size-2 rounded-full" style={{ background: c.color }} />}
                        {c.alerta && <IconAlertTriangle size={12} style={{ color: COLOR_NIVEL.atencion }} />}
                        {c.titulo}
                    </p>
                    <p className={`${compacto ? "text-lg" : "text-2xl"} font-bold leading-tight`}>{c.valor}</p>
                </div>
            ))}
        </div>
    );
}


export function AvancePorMuelle({ muelles, onSeleccionar }) {

    const [encima, setEncima] = useState(null);

    return (
        <div className={`${vidrio} w-72 p-4`}>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">Avance por muelle</h3>
                <div className="flex gap-3 text-[11px] text-texto-suave">
                    {Object.entries(COLOR_FASE).map(([fase, color]) => (
                        <span key={fase} className="flex items-center gap-1">
                            <span className="h-2 w-3 rounded-sm" style={{ background: color }} /> {fase}
                        </span>
                    ))}
                </div>
            </div>

            <ul className="space-y-2.5">
                {muelles.map((m) => {
                    const v = m.vehiculo;
                    return (
                        <li key={m.numero}>
                            <button
                                className="relative grid w-full grid-cols-[2.2rem_1fr_2.6rem] items-center gap-2 text-left text-xs"
                                onClick={() => onSeleccionar(m.numero)}
                                onMouseEnter={() => setEncima(m.numero)}
                                onMouseLeave={() => setEncima(null)}
                            >
                                <span className="font-semibold text-texto-suave">M{m.numero}</span>
                                <span className="h-2.5 overflow-hidden rounded-full bg-borde/60">
                                    {v && (
                                        <motion.span
                                            className="block h-full rounded-r-[4px]"
                                            style={{ background: COLOR_FASE[v.fase] }}
                                            initial={false}
                                            animate={{ width: `${v.porcentaje}%` }}
                                            transition={{ type: "spring", stiffness: 140, damping: 22 }}
                                        />
                                    )}
                                </span>
                                <span className="text-right font-semibold tabular-nums">{v ? `${v.porcentaje}%` : "Libre"}</span>

                                {encima === m.numero && v && (
                                    <span className="pointer-events-none absolute -top-9 left-10 z-10 whitespace-nowrap rounded-md border border-borde bg-fondo px-2 py-1 text-[11px] shadow-lg">
                                        {v.placa} · {v.fase} {v.porcentaje}% · {v.tipologia?.nombre ?? "sin tipología"}
                                    </span>
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}


/*
    Los vehículos que esperan muelle, en el orden de prioridad del
    panel (el mismo de la tabla de patio de siempre). El número es
    su puesto en la fila; el color, el semáforo de espera.
*/
export function ListaPatio({ patio, seleccionado, onSeleccionar, colorNivel }) {

    const [abierta, setAbierta] = useState(true);

    return (
        <div className={`${vidrio} flex min-h-0 w-56 flex-col overflow-hidden`}>
            <button
                onClick={() => setAbierta((a) => !a)}
                className="flex shrink-0 items-center gap-2 px-3 py-2 text-left text-sm font-semibold"
                aria-expanded={abierta}
            >
                <IconParking size={16} className="text-texto-suave" />
                En patio
                <span className="ml-auto rounded-full bg-fondo px-2 py-0.5 text-xs tabular-nums text-texto-suave">{patio.length}</span>
                <IconChevronDown size={15} className={`text-texto-suave transition-transform ${abierta ? "" : "-rotate-90"}`} />
            </button>

            {abierta && (
                <ul className="min-h-0 flex-1 overflow-y-auto border-t border-borde">
                    {patio.length === 0 && (
                        <li className="px-3 py-3 text-xs text-texto-suave">No hay vehículos en patio.</li>
                    )}
                    {patio.map((p) => {
                        const color = colorNivel(p.nivel);
                        const elegido = p.vehiculo.id === seleccionado;
                        return (
                            <li key={p.vehiculo.id} className="border-b border-borde/50 last:border-b-0">
                                <button
                                    onClick={() => onSeleccionar(p.vehiculo.id)}
                                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-fondo/70 ${elegido ? "bg-marca/20" : ""}`}
                                >
                                    <span
                                        className="flex h-6 min-w-6 items-center justify-center rounded-md border-2 px-1 text-[11px] font-bold tabular-nums"
                                        style={{ borderColor: color }}
                                    >
                                        {p.puesto}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-semibold">{p.vehiculo.placa}</span>
                                        <span className="block truncate text-[11px] text-texto-suave">{p.vehiculo.tipoOperacion}</span>
                                    </span>
                                    <span className="shrink-0 text-xs font-semibold tabular-nums" style={{ color }}>{p.textoEspera}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
