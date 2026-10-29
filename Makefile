# monorepo 构建入口：make / make hub / make agent / make theme / make admin / make release
# 依赖：node+npm（web-admin 与 web-site 是 Vite 工程）、Rust 工具链（hub 与 agent）。
#
# web-admin/dist 必须在 cargo 之前存在，所以 hub / check / test 都先跑 admin。公开页
# （web-site）不一样：build.rs 调 scripts/theme.sh 按源码指纹同步，源码变了才重建，构建
# 本身不联网。代价是全新 clone 要靠 `make theme` 先把依赖和 dist 备好；之后 `make hub`
# 会自己跟上 web-site 的改动。
#
# npm ci 只在 node_modules 缺失时执行：安装是一次性的，重复构建没有理由再付这份时间。

THEME_DIR := monitor/web-site
ADMIN_DIR := monitor/web-admin

.PHONY: all hub agent theme admin check test clean release

all: hub agent

theme:
	cd $(THEME_DIR) && { [ -d node_modules ] || npm ci; } && npm run build

admin:
	cd $(ADMIN_DIR) && { [ -d node_modules ] || npm ci; } && npm run build

hub: admin
	cd monitor && cargo build --release

agent:
	cd agent && cargo build --release

check: admin
	cd $(THEME_DIR) && { [ -d node_modules ] || npm ci; } && npm run lint
	cd $(ADMIN_DIR) && npm run lint
	cd monitor && cargo check
	cd agent && cargo check

test: admin
	cd $(THEME_DIR) && { [ -d node_modules ] || npm ci; } && npm test
	cd $(ADMIN_DIR) && npm test
	cd monitor && cargo test
	cd agent && cargo test

# 版本号各自写在 monitor/、agent/ 的 Cargo.toml 和 Cargo.lock 里，`--locked`
# 要求 lock 先改好。脚本按参数决定 bump 谁（VERSION= 两者同号；HUB=/AGENT=
# 只动一个），改号、提交就停：push 和 tag 等你看到 CI 绿了再打，tag 号是
# 纯发行序号，脚本末尾会算好。
#   make release VERSION=0.2.2
#   make release HUB=0.2.2
#   make release HUB=0.2.2 AGENT=0.3.0
release:
	@./scripts/release.sh $(if $(VERSION),$(VERSION),$(if $(HUB),HUB=$(HUB))$(if $(AGENT), AGENT=$(AGENT)))

clean:
	rm -rf $(THEME_DIR)/dist $(ADMIN_DIR)/dist monitor/target agent/target
