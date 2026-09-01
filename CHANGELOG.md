# Muudatused

Kõik alljärgnev on valmis ja testitud, aga **serverisse veel viimata**
(4 commit'i, mida `origin/main` peal veel ei ole).

---

## Uued võimalused

### Kopeeri pingid — `/games who`

Mängu juures on nüüd nupp **Kopeeri pingid**. See annab sulle kõigi mängijate
nimekirja koodiplokis, mille Discord laseb ühe klikiga kopeerida. Kleebi see
kuhu tahad — igast nimest saab seal päris ping.

Nimekirja näed ainult sina, ja selle avamisest ei saa keegi teadet. Ping tuleb
alles siis, kui sa ise kuhugi kleebid.

Vana **Pingi neid** nupp töötab edasi ja teavitab inimesi kohapeal.

### Mängude valimise nimekiri on selgem

Iga mängu real on nüüd oma linnukese nupp — vajutad otse mängu peale, eraldi
menüüd enam ei ole.

Lehel on 10 mängu senise 25 asemel. See ei ole maitse küsimus: Discord lubab
ühes sõnumis piiratud arvu elemente ja üks mängurida kulutab neist kolm,
nii et rohkem lihtsalt ei mahu.

**Märgi kõik** ja **Eemalda kõik** on nüüd üks nupp, mis vahetab tähendust
vastavalt sellele, kas kõik on juba märgitud.

### `/steam update` ei mäleta enam sinu keeldumisi

Varem jättis bot meelde, millised mängud sa importimata jätsid. Nüüd ei
salvestata sellest **mitte midagi** — ka vana andmebaasist kustutatakse see
tabel esimesel käivitamisel.

Selle asemel: `/steam update` märgib ette täpselt need mängud, mis sul juba
kogus on. Kõik ülejäänud tulevad märkimata ja ekraan ütleb, mitu uut mängu
valimata on.

---

## Parandused

### `/steam unlink` kustutas käsitsi lisatud mängud

Steami lahutamine viis kaasa ka need mängud, mille sa ise käsitsi lisasid
(näiteks Minecraft) — mängud, mis ei tulnudki Steamist ja mille jaoks ei pea
Steami kontot üldse olema. Nüüd jäävad need alles ja bot ütleb sulle, et jäid.

Kõige kustutamiseks on endiselt `/privacy`.

### `/games list` ei näidanud käsitsi lisatud mänge

Käsitsi lisatud mängul ei ole mänguaega, ja 30-minutiline vaikefilter viskas
need vaikselt välja. Nii nägi inimene, kes oli mänge ainult käsitsi lisanud,
tühja nimekirja ja teadet, et tal pole ühtki mängu.

### `/games who` näitas peidetud mängu

Kui mängu ainus omanik oli selle `/steam change`'iga ära peitnud, näitas bot
ikka veel mängu nime, pilti ja poe linki — ainult mängijate nimekiri oli tühi.
See luges nagu "seda ei mängi siin keegi", mitte "see ei puutu sinusse".
Nüüd ei leia bot sellist mängu üldse.

### `/games who` näitas Steami nime käsitsi lisatud mängu juures

Käsitsi lisatud mäng ei tule Steamist ja inimesel ei pruugi Steami kontot
ollagi. Steami nime enam nende ridade juures ei näidata.

### `min_playtime: 0` tähendab nüüd päriselt "kõik"

Varem tähendas 0 "üle 0 minuti", mis peitis ära iga mängu, mille mänguaeg on
täpselt 0 — täpselt vastupidine sellele, mida 0 kirjutades küsitakse.

### `/roles remove` ei eemaldanud reaktsiooni

Rolli paneelilt eemaldades jäi emoji sõnumile alles. Klikkimine ei teinud enam
midagi, aga nupp oli endiselt näha. Nüüd eemaldatakse ka reaktsioon.

### `/steam change` sõnastus oli eksitav

Ekraanil oli kirjas "selles serveris", aga mängu peitmine kehtib kõikjal, kus
bot on. Tekst on nüüd tõele vastav. (`/privacy` nähtavuse lüliti on
tõesti serveripõhine — need kaks nägid ühtemoodi välja, aga ei ole seda.)

---

## Turvalisus

### Reaktsioonirollid: õigusi kontrollitakse nüüd ka rolli andmise hetkel

Bot keeldub paneelile panemast rolli, millel on moderaatori õigused. Seda
kontrolliti aga **ainult siis, kui roll paneelile lisati**.

Probleem: kui keegi lisas hiljem serveri sätetes tavalisele värvirollile
näiteks **Manage Messages** õiguse, jäi see roll paneelile alles — ja iga
liige sai selle õiguse endale lihtsalt reaktsiooniga võtta.

Nüüd kontrollitakse õigusi ka igal rolli andmisel. Roll jäetakse andmata, seos
eemaldatakse paneelilt ja inimesele öeldakse, miks. Rolli **äravõtmine** töötab
edasi — vastasel juhul jääks roll lõksu neile, kellel see juba on.

### Nupud ei püsi enam võõraste klikkide toel elus

**Kopeeri pingid** on meelega kõigile avatud. Aga iga klikk pikendas sõnumi
eluiga, nii et võõras sai käsu käivitaja **Pingi neid** nuppu tunde kaua
aktiivsena hoida. Ping-nupul on nüüd oma kell, mida liigutab ainult see, kes
käsu käivitas.

### Mängude eemaldamine on piiratud käsitsi lisatutega

Paneeli **Eemalda** nupp lubas põhimõtteliselt kustutada ka Steamist tulnud
ridu. Piirang on nüüd andmebaasi päringus endas, mitte ainult selles, mida
nupp välja pakub.
