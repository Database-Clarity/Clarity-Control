import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FinderPicker, type PickerSection } from '../src/features/navigation/FinderPicker';
import '../src/ui/global.scss';

const icon = 'https://www.bungie.net/fixture.png';
const sections: PickerSection[] = ['Weapons', 'Armor', 'Activities', 'Other'].map(
  (label, group) => ({
    label,
    options: Array.from({ length: 8 }, (_, index) => ({
      id: `${group}-${index}`,
      label:
        group === 3 && index === 7 ? 'Inactive & Placeholders' : `${label} option ${index + 1}`,
      icon,
    })),
  }),
);
function Fixture() {
  const [category, setCategory] = useState('3-7');
  const [group, setGroup] = useState('3-7');
  return (
    <div style={{ margin: '160px 16px 0', display: 'flex', gap: 8 }}>
      <FinderPicker
        label="Category"
        sections={sections}
        value={category}
        onChange={setCategory}
        icons
      />
      <FinderPicker
        label="Group"
        sections={[{ options: sections.flatMap((section) => section.options) }]}
        value={group}
        onChange={setGroup}
        icons
      />
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
