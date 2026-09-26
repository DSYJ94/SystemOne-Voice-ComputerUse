.PHONY: test test-swift fixtures

PYTHON ?= .venv/bin/python

test:
	npm run check
	$(PYTHON) packages/protocol/validate_contract.py

test-swift:
	npm run test:swift

fixtures:
	npm run fixtures
