# UniStore — Painel administrativo

Site estático para operar a plataforma UniStore: verificações de vendedor, lojas e selos,
anúncios, pedidos, comunicados, conteúdo e auditoria.

- **Sem servidor, sem build, sem dependências.** Só HTML, CSS e JavaScript.
- **Sem chaves no código.** O acesso depende de uma conta Firebase com a custom claim
  `admin: true`; as Regras do Firestore recusam tudo o resto.
- Publicado por **GitHub Pages** a partir deste repositório.

---

## 1. Primeiro acesso (só falta isto)

Ao abrir o site pela primeira vez, aparece um ecrã **Configuração inicial**. Cole dois valores
da app Web do Firebase:

**Firebase Console → Project settings → Your apps → Web (`</>`)**

```text
apiKey   (começa por AIza...)
appId    (formato 1:...:web:...)
```

`authDomain` e `projectId` já vêm preenchidos (`unistore-6029a`). Os valores ficam guardados
apenas no navegador onde os colar; nada é enviado para o repositório.

Antes de entrar, confirme no Firebase:

1. **Authentication → Sign-in method** → **Email/Password** activo.
2. **Authentication → Users** → a conta administrativa existe.
3. **Authentication → Settings → Authorized domains** → `euclides-uncom.github.io` presente.
4. A conta tem a claim `admin: true` (ver secção 2).

## 2. Conceder/verificar a claim de administrador

No Cloud Shell, com a credencial de serviço do projecto `unistore-6029a`:

```bash
set -e
cd "$HOME"
rm -rf unistore-tools
gh repo clone euclides-uncom/PerfumesMoz unistore-tools -- --depth 1 --branch main
cd unistore-tools
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/unistore-private-service-account.json"
[ -f "$GOOGLE_APPLICATION_CREDENTIALS" ] || { echo "FALTA a chave de serviço"; exit 1; }
(cd scripts && npm ci --no-audit --no-fund)
node scripts/grant-admin.js O_SEU_EMAIL_ADMIN
```

Se a chave não existir:

```bash
gcloud config set project unistore-6029a
gcloud iam service-accounts keys create "$HOME/unistore-private-service-account.json" \
  --iam-account=unistore-private-api@unistore-6029a.iam.gserviceaccount.com \
  --project=unistore-6029a
```

**Alternativa sem npm (REST).** Se a chave de serviço não estiver disponível, a mesma claim
pode ser gravada com a conta Google do Cloud Shell. O Identity Toolkit exige o cabeçalho
`x-goog-user-project`, caso contrário devolve `403 … requires a quota project`:

```bash
PROJECT=unistore-6029a
EMAIL=O_SEU_EMAIL_ADMIN
T="$(gcloud auth print-access-token)"
ID="$(curl -sS -X POST "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts:lookup" \
  -H "Authorization: Bearer $T" -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" -d "{\"email\":[\"$EMAIL\"]}" \
  | python3 -c 'import sys,json;u=json.load(sys.stdin).get("users") or [];print(u[0]["localId"] if u else "")')"
[ -n "$ID" ] || { echo "SEM UID - criar a conta em Authentication > Users"; exit 1; }
curl -sS -X POST "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts:update" \
  -H "Authorization: Bearer $T" -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" \
  -d "{\"localId\":\"$ID\",\"customAttributes\":\"{\\\"admin\\\":true}\"}"
```

Confirmar (deve imprimir `{"admin":true}`):

```bash
curl -sS -X POST "https://identitytoolkit.googleapis.com/v1/projects/$PROJECT/accounts:lookup" \
  -H "Authorization: Bearer $T" -H "x-goog-user-project: $PROJECT" \
  -H "Content-Type: application/json" -d "{\"localId\":[\"$ID\"]}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["users"][0].get("customAttributes","AUSENTE"))'
```

Nunca use `UID` como nome de variável em bash: é uma variável de leitura obrigatória e
qualquer atribuição falha com `UID: readonly variable`, deixando o valor `1000`.

Depois do `✅ Admin concedido`, **termine a sessão e volte a entrar** no painel: a claim só
entra num token novo.

Revogar: acrescente `--revoke` ao comando.

## 3. Autorizar a origem do painel na API privada

Em **Appwrite → UniStore Private API → Settings → Variables**, e também na Function de limpeza:

```text
PANEL_ORIGIN = https://euclides-uncom.github.io
```

Origem exacta: `https://`, sem barra no fim, sem caminho, sem `*`. Sem este passo, as imagens
e as decisões respondem `403 Origem não autorizada` — o painel mostra a origem que deve
configurar.

## 4. O que o painel faz

| Área | Acções |
|---|---|
| Visão geral | contagens, fila de verificações, expirações em 48 h, verificações presas |
| Verificações | ver documento e selfie, aprovar/rejeitar com motivo e confirmação de análise |
| Lojas | VIP, Exclusiva, suspender, reactivar |
| Anúncios | ocultar/publicar |
| Pedidos | consulta (entregas desactivadas) |
| Comunicados | publicar mensagens por audiência |
| Conteúdo | editar Sobre, Privacidade e Termos |
| Auditoria | histórico de decisões e acções |
| Definições | estado do serviço, parâmetros, limites |

Como a segurança é garantida:

- As imagens vêm da API privada com a sessão do administrador, **sem cache**, e cada acesso é
  registado em `sellerAudit`.
- Aprovar/rejeitar passa **sempre** pela API, que confirma a eliminação dos dois ficheiros
  cifrados antes de gravar a decisão. Não existe atalho no painel.
- O painel não cria vendedores, não confirma pagamentos e não activa entregas.

## 5. Publicar / actualizar

Este conteúdo vive em `admin-panel/` no repositório principal (privado). Para criar ou actualizar
o site público:

```bash
set -e
cd "$HOME"
rm -rf UniStore-painel
gh repo clone euclides-uncom/PerfumesMoz unistore-tools -- --depth 1 --branch main
cp -r unistore-tools/admin-panel UniStore-painel
cd UniStore-painel
git init -b main
git add -A
git commit -m "Painel administrativo UniStore"
gh repo create euclides-uncom/UniStore-painel --public \
  --description "Painel administrativo UniStore (site estático)" --source . --push
gh api -X POST repos/euclides-uncom/UniStore-painel/pages \
  -H "Accept: application/vnd.github+json" \
  -f 'source[branch]=main' -f 'source[path]=/'
```

Se o repositório já existir, use `git remote add origin ...` + `git push -u origin main`, e para
actualizar o Pages: `gh api -X PUT repos/euclides-uncom/UniStore-painel/pages -f 'source[branch]=main' -f 'source[path]=/'`.

## Problemas comuns

| Sintoma | Causa | Solução |
|---|---|---|
| “Configuração inicial” outra vez | navegador sem os valores guardados | colar `apiKey` e `appId` novamente |
| `auth/unauthorized-domain` | domínio não autorizado | Authentication → Authorized domains |
| “Acesso negado” | conta sem `admin: true` | secção 2 e novo login |
| `PERMISSION_DENIED` nas listas | regras antigas ou sem claim | publicar regras v4 e confirmar claim |
| `403 Origem bloqueada` | `PANEL_ORIGIN` errada/ausente | secção 3 |
| Imagens não abrem | API inacessível ou origem | verificar `API_BASE` em `config.js` e secção 3 |

## Limites

- Ferramenta de operação: não substitui revisão jurídica, política de retenção publicada,
  NUIT/contactos do operador nem processo de reclamações.
- Aprovar confirma que **viste** documento e selfie e que correspondem aos dados da conta.
  É uma decisão humana registada; não é verificação biométrica.
- Eliminar do armazenamento activo não garante apagamento de backups do fornecedor.
- Antes de produção: revogar a chave antiga das fotos públicas embutida no APK e usar contas
  administrativas individuais.
