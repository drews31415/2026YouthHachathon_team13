import { useEffect, useId, useRef, useState } from 'react';
import { MapPin, TrainFront, Building2, Search, X } from 'lucide-react';
import { findPlaces } from '../core/engine';
import type { Network, Place } from '../core/types';

interface Props {
  network: Network;
  label: string;
  value: string;
  kind: 'origin' | 'destination';
  onChange: (value: string) => void;
  onSelect: (place: Place) => void;
}

export function PlaceInput({ network, label, value, kind, onChange, onSelect }: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const places = findPlaces(network, value).slice(0, 30);
  const select = (place: Place) => { onSelect(place); setOpen(false); input.current?.focus(); };
  useEffect(() => {
    if (open && places[active]) document.getElementById(`${id}-${places[active].id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, id, value]);

  return <div className={`place-field ${kind}`}>
    <span className="place-dot" aria-hidden="true" />
    <div className="place-field-body">
      <label htmlFor={id}>{label}</label>
      <div className="place-input-row">
        <input ref={input} id={id} value={value} placeholder={`${label}를 검색하세요`}
          role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={`${id}-list`}
          aria-activedescendant={open && places[active] ? `${id}-${places[active].id}` : undefined}
          autoComplete="off"
          onFocus={() => { setOpen(true); setActive(0); }}
          onBlur={() => { window.setTimeout(() => setOpen(false), 140); }}
          onChange={event => { onChange(event.target.value); setOpen(true); setActive(0); }}
          onKeyDown={event => {
            if (event.key === 'Escape') setOpen(false);
            if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(a => Math.min(a + 1, places.length - 1)); }
            if (event.key === 'ArrowUp') { event.preventDefault(); setActive(a => Math.max(0, a - 1)); }
            if (event.key === 'Enter' && open && places[active]) { event.preventDefault(); select(places[active]); }
          }} />
        {value && <button className="clear-input" type="button" aria-label={`${label} 지우기`} onClick={() => { onChange(''); input.current?.focus(); }}><X size={15} /></button>}
      </div>
    </div>
    {open && <div className="place-dropdown" id={`${id}-list`} role="listbox" aria-label={`${label} 검색 결과`}>
      <div className="dropdown-caption"><Search size={12} /> OpenStreetMap에 등록된 실제 장소</div>
      {places.length ? places.map((place, index) => <button type="button" role="option" aria-selected={active === index}
        key={place.id} id={`${id}-${place.id}`} className={active === index ? 'active' : ''}
        onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(place)}>
        <span className="place-result-icon">{place.name.includes('역') ? <TrainFront size={17} /> : place.name.includes('청') ? <Building2 size={17} /> : <MapPin size={17} />}</span>
        <span><strong>{place.name}</strong><small>{place.category}</small></span>
      </button>) : <p className="no-places">수집된 생활권에 일치하는 장소가 없어요.<br />다른 이름을 검색하거나 지도에서 위치를 선택해 주세요.</p>}
    </div>}
  </div>;
}
