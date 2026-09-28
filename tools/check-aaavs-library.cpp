#define NOMINMAX
#include "../src/mpc-hc/AAAVSLibrary.h"
#include <cassert>
#include <iostream>
int main() {
    using namespace AAAVSLibrary;
    const auto root=fs::current_path()/(L"fixture-"+std::to_wstring(GetCurrentProcessId()));
    fs::create_directories(root/L"catalog");fs::create_directories(root/L"presets/unique");
    const std::string hash(64,'a');const auto source=root/L"presets/unique/Test.avs";
    {std::ofstream f(source,std::ios::binary);f<<"unchanged preset bytes";}
    const auto old=fs::file_time_type::clock::now()-std::chrono::hours(24);fs::last_write_time(source,old);
    const auto catalog=root/L"catalog/presets.json";
    {std::ofstream f(catalog);f<<"{\"presets\":[{\"sha256\":\""<<hash<<"\",\"canonical_path\":\"presets/unique/Test.avs\"}]}";}
    Rate(root,hash,1);const auto one=root/L"presets/unique/Test [1 stars].avs";
    assert(!fs::exists(source)&&fs::exists(one));assert(Read(one)=="unchanged preset bytes");assert(fs::last_write_time(one)>old);
    Rate(root,hash,5);assert(!fs::exists(one));assert(fs::exists(root/L"presets/unique/Test [5 stars].avs"));
    Rate(root,hash,1);const auto contents=Read(catalog);const auto time=fs::last_write_time(one);
    {std::ofstream f(root/L"catalog/presets.json.writing");f<<"occupied transaction";}
    bool failed=false;try{Rate(root,hash,3);}catch(...){failed=true;}assert(failed);
    assert(fs::exists(one)&&!fs::exists(root/L"presets/unique/Test [3 stars].avs"));assert(Read(catalog)==contents);assert(fs::last_write_time(one)==time);
    fs::remove(root/L"catalog/presets.json.writing");
    for(const auto& path:{"presets/../escape.avs","C:/escape.avs","presets/unique/test.txt","presets/unique/../../escape.avs"}){failed=false;try{PresetPath(root,path);}catch(...){failed=true;}assert(failed);}
    failed=false;try{Rate(root,hash,0);}catch(...){failed=true;}assert(failed);
    failed=false;try{Rate(root,std::string(64,'b'),3);}catch(...){failed=true;}assert(failed);
    const std::string nervHash(64,'c');const auto nervSource=root/L"presets/unique/NERV 01 - Boot.nerv";
    const std::string manifest="{\"format\":\"mpcaaavs-nerv\",\"version\":1,\"scene\":\"boot\"}";
    {std::ofstream f(nervSource,std::ios::binary);f<<manifest;}fs::last_write_time(nervSource,old);
    rapidjson::Document mixed;mixed.Parse(Read(catalog).c_str());auto& allocator=mixed.GetAllocator();
    rapidjson::Value nerv(rapidjson::kObjectType);
    nerv.AddMember("sha256",rapidjson::Value(nervHash.c_str(),allocator),allocator);
    nerv.AddMember("canonical_path","presets/unique/NERV 01 - Boot.nerv",allocator);
    nerv.AddMember("kind","nerv",allocator);nerv.AddMember("scene","boot",allocator);
    mixed["presets"].PushBack(nerv,allocator);AtomicWrite(catalog,Json(mixed));
    Rate(root,nervHash,4);const auto nervRated=root/L"presets/unique/NERV 01 - Boot [4 stars].nerv";
    assert(!fs::exists(nervSource)&&fs::exists(nervRated));assert(Read(nervRated)==manifest);assert(fs::last_write_time(nervRated)>old);
    Rate(root,nervHash,2);const auto nervTwo=root/L"presets/unique/NERV 01 - Boot [2 stars].nerv";
    assert(!fs::exists(nervRated)&&fs::exists(nervTwo));assert(Read(nervTwo)==manifest);assert(fs::exists(one));
    mixed.Parse(Read(catalog).c_str());assert(mixed["presets"].Size()==2);
    assert(std::string(mixed["presets"][1]["kind"].GetString())=="nerv");assert(std::string(mixed["presets"][1]["scene"].GetString())=="boot");
    std::cout<<"Rating filesystem: AVS/NERV rename, timestamp, byte preservation, repeated rating, atomic rollback, mixed catalog, invalid paths and unknown IDs PASS\n";
}
