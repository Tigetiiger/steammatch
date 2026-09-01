# Muudatused

Valmis, aga serverisse veel viimata.

---

## Uus

### Kopeeri pingid — `/games who`

Mängu juures on nüüd nupp **Kopeeri pingid**. See annab sulle kõigi mängijate
nimekirja koodiplokis, mille Discord laseb ühe klikiga kopeerida. Kleebi see
kuhu tahad — igast nimest saab seal päris ping.

Nimekirja näed ainult sina, ja selle avamisest ei saa keegi teadet. Ping tuleb
alles siis, kui sa ise kuhugi kleebid.

Vana **Pingi neid** nupp töötab edasi ja teavitab inimesi kohapeal.

---

## Muutunud

### Mängude valimise nimekiri

Iga mängu real on nüüd oma linnukese nupp — vajutad otse mängu peale, eraldi
menüüd enam ei ole.

Lehel on 10 mängu senise 25 asemel. See ei ole maitse küsimus: Discord lubab
ühes sõnumis piiratud arvu elemente ja üks mängurida kulutab neist kolm,
nii et rohkem lihtsalt ei mahu.

**Märgi kõik** ja **Eemalda kõik** on nüüd üks nupp, mis vahetab tähendust
vastavalt sellele, kas kõik on juba märgitud.

### `/steam update` ei mäleta enam sinu keeldumisi

Varem jättis bot meelde, millised mängud sa importimata jätsid. Nüüd ei
salvestata sellest **mitte midagi** — ka vanast andmebaasist kustutatakse see
esimesel käivitamisel.

Selle asemel märgib `/steam update` ette täpselt need mängud, mis sul juba
kogus on. Kõik ülejäänud tulevad märkimata ja ekraan ütleb, mitu uut mängu
valimata on.

### `/games list` näitab nüüd ka käsitsi lisatud mänge

Käsitsi lisatud mängul ei ole mänguaega, ja 30-minutiline vaikefilter viskas
need varem vaikselt välja. Nii nägi inimene, kes oli mänge ainult käsitsi
lisanud, tühja nimekirja ja teadet, et tal pole ühtki mängu.

### `/steam unlink` jätab käsitsi lisatud mängud alles

Steami lahutamine viis varem kaasa ka need mängud, mille sa ise käsitsi lisasid
(näiteks Minecraft) — mängud, mis ei tulnudki Steamist ja mille jaoks ei pea
Steami kontot üldse olema. Nüüd jäävad need alles ja bot ütleb sulle, et jäid.

Kõige kustutamiseks on endiselt `/privacy`.

### `/games who` austab nüüd peidetud mänge

Kui mängu ainus omanik oli selle `/steam change`'iga ära peitnud, näitas bot
ikka veel mängu nime, pilti ja poe linki — ainult mängijate nimekiri oli tühi.
See luges nagu "seda ei mängi siin keegi". Nüüd ei leia bot sellist mängu üldse.

Samuti ei näidata enam Steami nime käsitsi lisatud mängu juures: selline mäng
ei tule Steamist ja inimesel ei pruugi Steami kontot ollagi.

### `min_playtime: 0` tähendab nüüd päriselt "kõik"

Varem tähendas 0 "üle 0 minuti", mis peitis ära iga mängu, mille mänguaeg on
täpselt 0 — täpselt vastupidine sellele, mida 0 kirjutades küsitakse.

### `/steam change` ütleb nüüd õigesti, kui laialt peitmine kehtib

Ekraanil oli kirjas "selles serveris", aga mängu peitmine kehtib kõikjal, kus
bot on. (`/privacy` nähtavuse lüliti on tõesti serveripõhine — need kaks nägid
ühtemoodi välja, aga ei ole seda.)

### `/roles remove` eemaldab nüüd ka reaktsiooni

Rolli paneelilt eemaldades jäi emoji varem sõnumile alles. Klikkimine ei teinud
enam midagi, aga nupp oli endiselt näha.
