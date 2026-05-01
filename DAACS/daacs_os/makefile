# ===== DAACS OS — Makefile =====

API_DIR := services/api
API_TEST_DIR := tests
API_VENV_RUN := python scripts/run_in_venv312.py

.PHONY: dev prod stop clean logs test test-api-local lint api-venv-local smoke-api-local

# ----- Development -----
dev:
	docker-compose up -d
	@echo "DAACS OS running at http://localhost:3000"
	@echo "API at http://localhost:8001"
	@echo "PostgreSQL at localhost:5432"
	@echo "Redis at localhost:6379"

dev-build:
	docker-compose up -d --build

# ----- Production -----
prod:
	docker-compose -f docker-compose.prod.yml up -d --build

# ----- Stop -----
stop:
	docker-compose down

clean:
	docker-compose down -v --remove-orphans
	@echo "Volumes and containers removed"

# ----- Logs -----
logs:
	docker-compose logs -f

logs-api:
	docker-compose logs -f api

logs-worker:
	docker-compose logs -f worker

logs-web:
	docker-compose logs -f web

# ----- Database -----
db-shell:
	docker-compose exec postgres psql -U daacs -d daacs

db-migrate:
	docker-compose exec api alembic upgrade head

db-reset:
	docker-compose exec postgres psql -U daacs -d daacs -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
	docker-compose exec postgres psql -U daacs -d daacs -f /docker-entrypoint-initdb.d/init.sql

# ----- Testing -----
test:
	docker-compose exec api pytest $(API_TEST_DIR) -v

test-api-local:
	cd $(API_DIR) && $(API_VENV_RUN) -m pytest $(API_TEST_DIR) -v

api-venv-local:
	cd $(API_DIR) && python scripts/rebuild_venv312.py

smoke-api-local:
	cd $(API_DIR) && $(API_VENV_RUN) scripts/db_smoke.py

test-e2e:
	cd tests/e2e && npx playwright test

test-load:
	cd tests/load && k6 run load_test.js

# ----- Linting -----
lint-api:
	docker-compose exec api ruff check .

lint-web:
	cd apps/web && npm run lint

lint: lint-api lint-web

# ----- Setup -----
setup:
	cp .env.example .env
	@echo "Edit .env with your API keys, then run: make dev"

# ----- Health Check -----
health:
	@curl -s http://localhost:8001/health | python -m json.tool
