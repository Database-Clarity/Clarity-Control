import unittest
from generate import append_revision, encode, project, resolve, records_from_snapshot


class HistoryTest(unittest.TestCase):
    def test_mixed_shape_placeholders_do_not_fabricate_mass_deletions(self):
        real = {'1': {'editor': {'en': {'main': 'Published'}}}}
        placeholders = {'1': {'hash': 1}, '2': {'hash': 2}}
        self.assertEqual(records_from_snapshot({**real, 'perks': placeholders}), real)
        self.assertEqual(records_from_snapshot({'perks': real}), real)
        self.assertEqual(records_from_snapshot(real), real)
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            records_from_snapshot({**real, 'perks': real})
        self.assertEqual(records_from_snapshot({'perks': placeholders}), {})

    def test_legacy_portuguese_spelling_is_preserved_without_guessing_conflicts(self):
        self.assertEqual(project({'editor': {'pt-rb': {'main': 'Texto'}}}), {'pt-br': 'Texto'})
        with self.assertRaises(ValueError):
            project({'editor': {'pt-rb': {'main': 'A'}, 'pt-br': {'main': 'B'}}})

    def test_missing_blank_and_deletion_are_distinct(self):
        lane = []
        for state in ({}, {'en': ''}, {'en': ''}, None, None, {'en': ''}):
            append_revision(lane, state, {'commit': 'a'})
        self.assertEqual([r['text'] for r in lane], [{}, {'en': ''}, None, {'en': ''}])

    def test_mapping_never_guesses_names_or_frames(self):
        self.assertEqual(resolve('1', {'1': {'to': 2, 'kind': 'sandbox'}}), '2')
        for kind in ('name', 'frame'):
            self.assertIsNone(resolve('1', {'1': {'to': 2, 'kind': kind}}))
        with self.assertRaises(ValueError):
            resolve('1', {'1': {'to': 1, 'kind': 'sandbox'}})

    def test_projection_and_serialization_are_exact(self):
        self.assertEqual(project({'editor': {'en': {'main': '', 'secondary': 'ignore'},
                                             'de': {'secondary': 'absent'}}}), {'en': ''})
        self.assertEqual(encode({'de': 'ä', 'en': 'text'}), encode({'en': 'text', 'de': 'ä'}))


if __name__ == '__main__':
    unittest.main()
