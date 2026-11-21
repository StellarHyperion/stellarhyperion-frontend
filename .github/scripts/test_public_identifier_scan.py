"""Check the exact public identifier exception against the real secret scanner."""

import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / ".github/security/gitleaks.toml"
PUBLIC_ADDRESS = "0xFd5a146686d16060ef9c595B37C30b248402304c"


class PublicIdentifierScanTests(unittest.TestCase):
    def scan(self, path, body):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body)
            for command in (
                ["git", "init", "--quiet"],
                ["git", "add", path],
                ["git", "-c", "user.name=dotmantissa",
                 "-c", "user.email=negativemantissa@gmail.com", "commit", "--quiet",
                 "--no-gpg-sign", "-m", "Synthetic secret scanner regression fixture"],
            ):
                subprocess.run(command, cwd=root, check=True, capture_output=True)
            result = subprocess.run(
                [os.environ.get("GITLEAKS", "gitleaks"), "git", "--redact", "--no-banner",
                 "--ignore-gitleaks-allow", "--gitleaks-ignore-path", directory,
                 "--config", str(CONFIG), "--log-opts=--all", "."],
                capture_output=True, text=True, cwd=root,
            )
            self.assertIn(result.returncode, (0, 1), "Secret scanner failed to run")
            return result.returncode

    def test_exact_public_value_in_exact_acceptance_path_is_not_a_secret(self):
        self.assertEqual(self.scan("test/backend-api.test.ts",
                                   f'const destinationToken = "{PUBLIC_ADDRESS}";\n'), 0)

    def test_same_value_in_another_path_remains_detected(self):
        self.assertEqual(self.scan("test/other.test.ts",
                                   f'const destinationToken = "{PUBLIC_ADDRESS}";\n'), 1)

    @staticmethod
    def synthetic_api_key():
        # Balanced synthetic characters make entropy-based detection deterministic.
        characters = "".join(chr(code) for code in (*range(65, 91), *range(97, 123), *range(48, 58)))
        return "".join(characters[(index * 17 + 5) % len(characters)] for index in range(48))

    def test_another_value_in_acceptance_path_remains_detected(self):
        self.assertEqual(self.scan("test/backend-api.test.ts",
                                   f'const api_key = "{self.synthetic_api_key()}";\n'), 1)

    def test_real_key_shape_is_detected_beside_the_public_identifier(self):
        body = (f'const destinationToken = "{PUBLIC_ADDRESS}";\n'
                f'const github_token = "ghp_{secrets.token_hex(18)}";\n')
        self.assertEqual(self.scan("test/backend-api.test.ts", body), 1)


if __name__ == "__main__":
    unittest.main()
