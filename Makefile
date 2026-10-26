# monorepo 构建入口：make / make hub / make agent / make theme / make admin
# 依赖：node+npm（web-admin 与 web-site 是 Vite 工程）、Rust 工具链（hub 与 agent）。
# 公开页主题（web-site）由 monitor/build.rs 调 scripts/theme.sh 自动同步构建（含按源码变更自动重构建），
# web-admin/dist 则需要在 cargo build 前存在，因此 hub 目标先跑 admin。

THEME_DIR := monitor/web-site
ADMIN_DIR  := monitor/web-admin

.PHONY: all hub agent theme admin check test clean

all: hub agent

theme:
	cd $(THEME_DIR) && npm install && npm run build

admin:
	cd $(ADMIN_DIR) && npm install && npm run build

hub: admin
	cd monitor && cargo build --release

agent:
	cd agent && cargo build --release

check: admin
	cd monitor && cargo check

test:
	cd $(THEME_DIR) && npm test
	cd $(ADMIN_DIR) && npm test
	cd monitor && cargo test
	cd agent && cargo test

clean:
	rm -rf $(THEME_DIR)/dist $(ADMIN_DIR)/dist monitor/target agent/target
