import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MapPin, TrainFront, Building2, X, Bike, BusFront, DoorOpen } from 'lucide-react';
import { findPlaces } from '../core/engine';
import type { Network, Place } from '../core/types';
import { fetchTmapPlaces } from '../services/tmap';

interface Props {
  network: Network;
  selected: Place | null;
  label: string;
  value: string;
  kind: 'origin' | 'destination';
  onChange: (value: string) => void;
  onSelect: (place: Place) => void;
}

function placeDisplay(category: string) {
  if (category.includes('출입구') || category.includes('subway_entrance')) return { Icon: DoorOpen, label: '지하철 출입구' };
  if (category === '시설 · bicycle_rental') return { Icon: Bike, label: '자전거 대여소' };
  if (category === '도로시설 · bus_stop') return { Icon: BusFront, label: '버스 정류장' };
  if (category === '대중교통 · platform') return { Icon: MapPin, label: '대중교통 승강장' };
  if (category.startsWith('철도 ·')) return { Icon: TrainFront, label: '철도역' };
  if (category.includes('government')) return { Icon: Building2, label: '공공기관' };
  if (category.includes('hospital')) return { Icon: Building2, label: '병원' };
  if (category.startsWith('기관 ·')) return { Icon: Building2, label: '기관' };
  return { Icon: MapPin, label: category.includes('교차로') ? '교차로' : '장소' };
}

export function PlaceInput({ network, selected, label, value, kind, onChange, onSelect }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const query = value.trim();
  const local = useMemo(() => query ? findPlaces(network, query).slice(0, 10) : [], [network, query]);
  const [remote, setRemote] = useState<{ query: string; places: Place[]; failed: boolean }>();
  const nationwide = open && selected?.name !== value && query.length >= 2 && query.length <= 80;
  const loaded = remote?.query === query ? remote : undefined;
  const places = nationwide && loaded ? [...local, ...loaded.places] : local;
  const showResults = open && !selected && !!query;
  useEffect(() => {
    if (!nationwide) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchTmapPlaces(query, controller.signal).then(places => {
        if (!controller.signal.aborted) setRemote({ query, places, failed: false });
      }).catch(() => {
        if (!controller.signal.aborted) setRemote({ query, places: [], failed: true });
      });
    }, 350);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, nationwide]);
  const select = (place: Place) => { onSelect(place); setOpen(false); input.current?.focus(); };
  useEffect(() => {
    if (open && places[active]) document.getElementById(`${id}-${places[active].id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id, value, places.length]);

  return <div className={`place-field ${kind}`}>
    <span className="place-dot" aria-hidden="true" />
    <div className="place-field-body">
      <label htmlFor={id}>{label}</label>
      <div className="place-input-row">
        <input ref={input} id={id} value={value} placeholder={kind === 'origin' ? '출발지를 검색하세요' : '목적지를 검색하세요'}
          role="combobox" aria-autocomplete="list" aria-expanded={showResults} aria-controls={showResults ? `${id}-list` : undefined}
          aria-activedescendant={showResults && places[active] ? `${id}-${places[active].id}` : undefined}
          autoComplete="off" maxLength={80}
          onFocus={() => { setOpen(true); setActive(0); }}
          onBlur={() => { window.setTimeout(() => setOpen(false), 140); }}
          onChange={event => { onChange(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'Escape') setOpen(false);
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(a => Math.max(0, Math.min(a + 1, places.length - 1))); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(a => Math.max(0, a - 1)); }
            if (event.key === 'Enter' && showResults && places[active]) { event.preventDefault(); select(places[active]); }
          }} />
        {value && <button className="clear-input" type="button" aria-label={`${label} 지우기`} onClick={() => { onChange(''); input.current?.focus(); }}><X size={15} /></button>}
      </div>
    </div>
    {showResults && <div className="place-dropdown" id={`${id}-list`} role="listbox" aria-label={`${label} 검색 결과`}>
      {places.map((place, index) => {
        const { Icon, label } = placeDisplay(place.category);
        return <button type="button" role="option" aria-selected={active === index}
        key={place.id} id={`${id}-${place.id}`} className={active === index ? 'active' : ''}
        onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(place)}>
        <span className="place-result-icon"><Icon size={17} /></span>
        <span><strong>{place.name}</strong><small>{place.address || label}</small></span>
      </button>; })}
      {nationwide && !loaded && <p className="no-places" role="status">전국 장소 검색 중…</p>}
      {nationwide && loaded?.failed && <p className="no-places" role="status">전국 장소 검색에 연결하지 못했어요. 지도에서 위치를 선택할 수 있어요.</p>}
      {!places.length && (!nationwide || (loaded && !loaded.failed)) && <p className="no-places">{query.length < 2 ? '두 글자 이상 입력해 주세요.' : '일치하는 장소를 찾지 못했어요.'}</p>}
    </div>}
  </div>;
}
