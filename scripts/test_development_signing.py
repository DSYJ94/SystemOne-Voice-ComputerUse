import unittest
from development_signing import choose_certificate, parse_identities, resolve_identity


class SigningTests(unittest.TestCase):
    def setUp(self):
        self.fingerprint = "A" * 40
        self.identity = [(self.fingerprint, "Apple Development: Local Test (TEST123456)")]

    def test_parse_only_valid_security_identity_rows(self):
        self.assertEqual(parse_identities('  1) ' + self.fingerprint +
            ' "Apple Development: Local Test (TEST123456)"\n  1 valid identities found\n'), self.identity)
        self.assertEqual(parse_identities('0 valid identities found'), [])

    def test_pin_survives_name_change_and_environment_override_is_explicit(self):
        self.assertEqual(resolve_identity(None, self.fingerprint, self.identity), self.fingerprint)
        self.assertEqual(resolve_identity("-", self.fingerprint, self.identity), "-")
        self.assertEqual(resolve_identity(self.identity[0][1], None, self.identity), self.fingerprint)

    def test_missing_or_revoked_pin_cannot_silently_fall_back(self):
        with self.assertRaises(ValueError):
            resolve_identity(None, self.fingerprint, [])
        self.assertEqual(resolve_identity(None, None, []), "-")

    def test_configure_requires_an_available_apple_certificate(self):
        self.assertEqual(choose_certificate(None, self.identity), self.fingerprint)
        for identities in [[], [("B" * 40, "Unrelated Certificate")],
                           self.identity + [("B" * 40, "Apple Development: Another")]]:
            with self.assertRaises(ValueError):
                choose_certificate(None, identities)
        with self.assertRaises(ValueError):
            choose_certificate("-", self.identity)
        with self.assertRaises(ValueError):
            choose_certificate("B" * 40, self.identity)


if __name__ == "__main__":
    unittest.main()
